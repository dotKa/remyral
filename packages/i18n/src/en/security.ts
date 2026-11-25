import type { Shape } from '../shape.js';
import type tr from '../tr/security.js';

export default {
  page: {
    label: 'Security',
    purpose:
      'How long an authenticator code stays valid, which actions ask for one and how autonomously agents work.',
    loading: 'Loading the security policy…',
    loadFailed: (p) => `Could not load the security policy: ${p.reason}`,
    readOnly: 'Only owners and administrators can change this policy.',
    version: (p) => `Version ${p.version} · ${p.who} · ${p.when}`,
    versionNever: (p) => `Version ${p.version} · installation default`,
    save: 'Save',
    saving: 'Saving…',
    saved: (p) => `Saved: ${String(p.count)} change(s).`,
    nothing: 'Nothing changed.',
    reset: 'Discard changes',
    failed: (p) => `Could not save: ${p.reason}`,
    chatHint:
      'You can also say all of this in the chat: “make the authenticator window one day”, “ask for a code on deploys”, “switch to strict”.',
  },
  presets: {
    title: 'Preset',
    customized: 'customized',
    apply: 'Apply this preset',
    confirmApply: (p) => `Applying ${p.name} resets every custom setting to that preset’s values. Continue?`,
    serbest: {
      name: 'Free',
      description:
        'A code holds for 12 hours; with “remember this device” the one code at sign-in covers the whole session. Only the safe core (security settings, 2FA, user and role changes, revealing secrets) asks for a code. NO code for: enabling machine administration, removing the sandbox, approving machines, production deploys, credentials, integrations, releases, MCP installs. Auto mode is on: approvals pass by themselves, deploys included; the assistant does explicit instructions directly. A hijacked session can do all of that without a code; choose it only for a single-person, closed installation.',
    },
    dengeli: {
      name: 'Balanced (default of a new install)',
      description:
        'A code holds for 4 hours; besides the safe core, credentials, logins, sandbox, machine admin, production deploys, integrations, releases and MCP installs ask for one. Deploys, force push, deletes outside the workspace and secret reads still ask a human. Auto mode is off.',
    },
    siki: {
      name: 'Strict',
      description:
        'The earlier behaviour: every privileged action asks for a code within the server window (default 10 min), account-security actions need a fresh code every time; no auto-approval, the assistant only prepares cards.',
    },
  },
  stepUp: {
    title: 'Authenticator code window',
    hint: 'One authenticator code stays valid for protected actions this long (at least 5 minutes, at most 30 days). The session’s own lifetime is always the limit.',
    window: 'Code valid for',
    serverDefault: (p) => `Server default (${p.minutes})`,
    serverDefaultPlain: 'Server default',
    custom: 'Custom (minutes)',
    minutes: (p) => `${String(p.n)} min`,
    hours: (p) => `${String(p.n)} h`,
    days: (p) => `${String(p.n)} days`,
    rememberDevice: 'Remember this device',
    rememberDeviceHint:
      'On a remembered device (trusted device or “Remember me”) one code holds until the session ends.',
    rememberServer: 'Server setting',
    rememberOn: 'On',
    rememberOff: 'Off',
    alwaysFresh: 'A fresh code every time for account-security actions',
    alwaysFreshHint:
      'Password changes, the vault, login relays and similar actions need a code from the last N minutes. Off: the window above applies.',
    alwaysFreshOff: 'Off',
    rangeError: 'The window must be between 5 minutes and 30 days.',
  },
  events: {
    title: 'Which actions ask for a code',
    hint: 'Actions that are on (Ask for TOTP) need a current authenticator code; actions that are off pass without one. The safe core is on by default in every preset.',
    ask: 'Ask for TOTP',
    core: 'Core',
    coreOffWarning:
      'You are turning off an action of the safe core: a stolen session could then do it without a code.',
    categories: {
      account: 'Account security',
      security: 'Security policy',
      users: 'Users and roles',
      secrets: 'Vault and secrets',
      machines: 'Machines and sandbox',
      deploy: 'Deploys and production',
      extensions: 'MCP and skill installs',
      workflows: 'Privileged workflow nodes',
      integrations: 'Integrations',
      policies: 'Project policies and limits',
      jobs: 'Jobs, approvals and chat cards',
      data: 'Data access and notification channels',
    },
    labels: {
      'account.password': 'Change your own password',
      'account.devices': 'Revoke every trusted device',
      'account.mfa': 'Disable / reset 2FA, recovery codes',
      'security.policy': 'Change the security policy',
      'users.roles': 'User and role changes, project memberships, service accounts',
      'api.tokens': 'Creating and rotating API tokens (personal and service account)',
      'credentials.write': 'Write, delete or unshare vault credentials',
      'secrets.reveal': 'Reveal a secret in plain text',
      'machines.fleet': 'Approve, revoke, drain, archive, rotate or update machines',
      'machines.config': 'Machine configuration, runtime policies, capacity, accounts',
      'machines.ops': 'Install / remove runtimes, restarts, logs, tools',
      'machines.logins': 'Runtime login / logout relay, removing an account',
      'machines.sandbox': 'Sandbox preparation, unconfined profile, project execution policy',
      'machines.admin': 'Machine administration (root / Administrator) jobs',
      'ide.start': 'Creating and starting Tam IDE workspaces (interactive code on a machine)',
      'deploy.production': 'Deploy requests and their approvals, deploy-on-success pre-approval',
      'deploy.targets': 'Deploy targets, auto-fix, verification settings',
      'deploy.coolify': 'Creating Coolify applications, environment variables and domains',
      'coolify.manage':
        'Coolify-wide changes: storages, start / restart, databases and backups, services, projects',
      'coolify.destructive':
        'Coolify changes that lose data or stop a site: removing storages, stopping, deleting',
      'releases.publish': 'Upload machine software releases and roll them out',
      'console.domain': "Change the console's public address (domain)",
      'host.update': 'Update or roll back the server (control plane), with an optional backup restore',
      'backups.manage':
        'Backups now, restore drills, backup schedule, retention, encryption keys and off-site target',
      'backups.restore': 'Replace the live database with a backup',
      'extensions.skills': 'Publish, import and assign skills',
      'extensions.mcp': 'Install MCP servers, their secrets, tool policy, assignments',
      'extensions.install_scripts': 'Approve an npm install script (the package’s code runs on the machines)',
      'extensions.ide':
        'IDE extensions: the allowlist, deny lists, a project’s required / recommended extensions and enforced settings',
      'workflows.privileged':
        'Save workflows with network, deploy or code nodes, activation, egress, sharing and attaching',
      'integrations.connections': 'GitHub, Coolify, Cloudflare and Bedrock connections',
      'integrations.git': 'Project Git settings and the Git identity',
      'integrations.webhooks': 'Create, change, resume outgoing webhooks and rotate or reveal their secret',
      'projects.policy': 'Create projects, approval rules, workspace, kill switch, queue settings',
      'limits.budgets': 'Quotas, budgets, prices',
      'models.routing': 'Model profiles and routing rules',
      'context.admin': 'Context and memory administration (delete, retention, search, defaults)',
      'chat.settings': 'Chat assistant settings',
      'approvals.decide': 'Decide approval requests and workflow approvals',
      'jobs.control': 'Run a job now, resume, switch account, approval mode',
      'automations.manage': 'Automations, schedules and templates',
      'chat.cards': 'Confirm chat cards (job, workflow run, message, monitor)',
      'data.access': 'Export the audit log, usage and jobs',
      'support.report':
        'Send the diagnostics report to the support address by e-mail; the support address and SMTP',
      'notifications.channels': 'Notification channels and push subscriptions',
    },
  },
  /** p16-api-tokens (ADR-0058): API tokens and service accounts. */
  apiTokens: {
    title: 'API tokens',
    hint: 'Personal tokens and service-account tokens for automation. A token can never give an authenticator code.',
    personal: 'Allow personal API tokens',
    personalHint:
      'When off, only service accounts get tokens; existing personal tokens keep working (revoke them on the Service accounts page).',
    maxDays: 'Longest lifetime of a token',
    maxDaysHint: 'For new and rotated tokens. A lifetime is always required.',
    days: '{n} days',
    eventGrants: 'Administrators may grant tokens actions that ask for a code',
    eventGrantsHint:
      'Off (the default): every action that asks for an authenticator code is refused for tokens. On: an administrator creating a token may allow chosen actions with a current code; the safe core can never be granted.',
  },
  card: {
    label: 'Setting',
    kind: 'Settings change',
    target: 'Target',
    changed: 'Changes',
    project: 'Project',
    machine: 'Machine',
    reason: 'Reason',
    targets: {
      security_policy: 'Security policy',
      apply_autonomy: 'Apply the autonomy defaults to existing projects',
      project_execution: 'Project execution policy',
      project_approval_rules: 'Project approval rules',
      worker_runtime_policy: 'The machine’s runtime policy',
    },
  },
  autonomy: {
    title: 'Agent autonomy',
    hint: 'Defaults for new projects and jobs. A project’s own setting always applies; nothing a machine does not allow is switched on.',
    hostExecution: 'Allow host execution in new projects',
    autoApprove: 'Allow “Never ask” jobs in new projects',
    jobApproval: 'Default approval mode of jobs',
    jobApprovalAllowAll: 'Never ask (where the project allows it)',
    jobApprovalAskSensitive: 'Ask for sensitive steps',
    chatDirect: 'Explicit commands in the chat run without a card',
    chatDirectHint:
      'Commands you write yourself, such as “approve the PRs” or “deploy”, run at once; only the assistant’s own suggestions, automatic messages and actions that need a code wait as cards. Switch it off to confirm every action on a card.',
    maxJobMinutes: 'Largest time limit of a job',
    maxJobMinutesHint: 'A time limit set on a card or extended while a job runs cannot exceed this.',
    applyExisting: 'Apply to existing projects',
    applyExistingHint:
      'Every project (except Machines) takes the “new project” settings above. The unconfined profile is never switched on.',
    applyConfirm: 'The execution settings of every existing project will change. Continue?',
    applied: (p) => `${String(p.count)} project(s) updated.`,
    rulesTitle: 'Risk-based approval rules',
    rulesHint:
      'For “Never ask” jobs these master approvals pass by policy (on) or still ask a human (off). Machine administration commands always keep their own two switches.',
    passes: 'Passes by policy',
    actions: {
      'git.push_protected': 'Push to a protected branch',
      'git.merge': 'Merge into a protected branch',
      'git.force_push': 'Force push / history rewrite',
      deploy: 'Deploy (production included)',
      'fs.delete_outside_workspace': 'Delete files outside the workspace',
      'network.egress_non_allowlisted': 'Network access outside the allowlist',
      'secret.read': 'Read a secret beyond the granted ones',
      'runtime.dangerous_tool': 'A tool call the runtime asks approval for',
      'job.budget_increase': 'Raise a job’s budget',
      'tool.mcp': 'An MCP tool call marked “ask”',
    },
  },
  /** p16-zip-job-input (ADR-0060): what may reach a job as input files from a .zip. */
  inputs: {
    title: 'Job input files',
    hint: 'A .zip dropped into the chat or the job composer becomes the job’s input files (in/). Every file type is allowed except native programs and libraries.',
    switch: 'Allow executables as job inputs',
    switchHint:
      'On: native programs and libraries (ELF, Windows .exe / .dll, macOS Mach-O, .so, .dylib) may reach an agent’s working folder from a .zip. Off: they are refused, named one by one. Default: off.',
  },
} satisfies Shape<typeof tr>;
