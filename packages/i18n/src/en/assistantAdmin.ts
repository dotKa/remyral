import type { Shape } from '../shape.js';
import type tr from '../tr/assistantAdmin.js';

/**
 * p16-assistant-admin: administration from the chat — users, memberships, machines, the release rollout,
 * notifications, integrations. The assistant's administration cards (settings card, target "admin") and the one-time
 * temporary password. Values are filled with `{name}` placeholders (`fill`).
 */
export default {
  card: {
    kind: 'Administration',
    action: 'Action',
    user: 'User',
    role: 'Role',
    previousRole: 'Previous role',
    project: 'Project',
    machine: 'Machine',
    channel: 'Channel',
    version: 'Version',
    rollout: 'Rollout',
    rolloutValue: '{version} · {percent}% of the machines',
    previous: 'Before',
    provider: 'Connection',
    kinds: 'Notification kinds',
    email: 'E-mail address',
    webhook: 'Webhook URL',
    changed: 'changes',
    removed: 'is removed',
    reason: 'Reason',
    force: 'Without waiting for running jobs',
    privileged: 'Also run the privileged helper',
    destructive:
      'Hard to undo: confirmed only with this card unless the security policy allows destructive administration from the chat.',
    reveal:
      'When you confirm, the temporary password is shown once on this card only; it never goes into the chat.',
    ops: {
      'user.invite': 'Invite a user',
      'user.set_role': 'Change the account role',
      'user.enable': 'Enable the account',
      'user.disable': 'Disable the account',
      'member.add': 'Add a project member / change the role',
      'member.remove': 'Remove a project membership',
      'machine.approve': 'Approve the machine pairing',
      'machine.reject': 'Reject the machine pairing',
      'machine.revoke': 'Revoke the machine',
      'machine.rotate_key': 'Rotate the machine key',
      // p19-chat-machine-admin
      'machine.prepare': 'Prepare the machine’s sandbox',
      'release.set_rollout': 'Set the release rollout',
      'release.pause': 'Pause the release rollout',
      'release.rollback_machine': 'Roll a machine back',
      'notifications.update': 'My notification preferences',
      'integration.check': 'Test the integration',
      'workflow.cancel_run': 'Cancel the workflow run',
      'workflow.decide_node': 'Decide a workflow approval step',
      'backup.run': 'Take a backup now',
      'backup.drill': 'Start a restore drill',
      'backup.restore': 'Restore the database from a backup',
      'host.upgrade': 'Update Remyral',
      'template.from_job': 'Save the job as a template',
      'monitor.update': 'Change the uptime monitor',
      'deploy.health_recheck': 'Run the health check again',
      'job.answer_question': 'Answer the job’s question',
      'cost_brake.lift': 'Lift the cost brake for a while',
      'cost_brake.end_lift': 'End the brake lift',
      'cost_brake.project_ceiling': 'Project spend ceiling',
      // p18-leftovers
      'budget.create': 'New budget',
      'budget.update': 'Change the budget',
      'budget.delete': 'Delete the budget',
      // p18-project-bootstrap
      'project.network': 'Network access of the project',
      'project.machines': 'Machines of the project',
      // p19-ide W4
      'code.request_changes': 'Request changes',
    },
    groups: {
      workflow: 'Workflow',
      backup: 'Backup',
      host: 'Update',
      template: 'Template',
      monitor: 'Uptime',
      deploy: 'Deploy',
      job: 'Job question',
      cost_brake: 'Cost brake',
      budget: 'Budget',
      project: 'Project setup',
      code: 'Code review',
    },
    gaps: {
      workflow: 'Workflow',
      node: 'Step',
      step: 'Step title',
      decision: 'Decision',
      approve: 'Approve',
      deny: 'Deny',
      backup: 'Backup',
      newest: 'the newest',
      template: 'Template name',
      prompt: 'Prompt (start)',
      monitor: 'Monitor',
      changes: 'Changes',
      url: 'Address',
      answers: 'Answer',
      scope: 'Scope',
      global: 'everything',
      hours: 'Hours',
      ceiling: 'Ceiling (USD)',
      ceilingValue: 'daily {daily} · monthly {monthly}',
      release: 'Release note',
      breaking: 'This release has breaking changes:',
      // p18-leftovers: budget cards.
      budget: 'Budget',
      budgetValue: '{limit} {metric} / {window} · {scope}',
      budgetFrom: 'Now',
      budgetOff: 'off',
      loosens:
        'This change loosens the budget (more work runs before it holds). Unless you asked for it explicitly, only this card confirms it.',
      always:
        'The live database is replaced with this backup; everything written since is lost. This is never done directly: only this card confirms it, with a current authenticator code.',
    },
  },
  /** p18-project-bootstrap: the project setup cards (network access, machines). */
  setup: {
    network: 'Network access',
    networkNow: 'Now',
    modes: {
      none: 'Off (model APIs only)',
      allowlist: 'Allowed only',
      web: 'Whole public web (443)',
    },
    reach: '{mode}: {list}',
    nothing: 'no list',
    opens:
      'This change opens network access for the project’s jobs. Unless you asked for it explicitly it is confirmed only on this card.',
    assign: 'Machines to assign',
    unassign: 'Machines to take off',
    preferred: 'Preferred machines',
    preferredNone: 'no preference',
    preferredNote:
      'Every job of the project tries these machines first; another eligible machine runs it when they cannot.',
  },
  password: {
    title: 'Temporary password',
    save: 'Copy this password now and pass it to the new user over a safe channel: it is not shown again. At first sign-in they set up an authenticator and change the password.',
    copy: 'Copy the password',
    user: 'for {username}',
  },
  settings: {
    chatDestructive: 'The chat may run destructive administration without a card',
    chatDestructiveHint:
      'Off (recommended): the assistant proposes disabling an account or revoking a machine only as a card, even when you ask for it explicitly and even in auto mode. Events that need a code ask for one either way.',
    chatMachineAdmin: 'Machine commands from the chat run at once',
    chatMachineAdminHint:
      'On: when your own chat message asks for work on a machine (install a package, configure a service, prepare the sandbox), the assistant does it at once — the administrator (root / Administrator) commands of the machine administration job it starts pass by policy without a separate approval, and a privileged prepare needs no fresh code. Every command is logged. The admin role and machine administration enabled on the machine are still required; messages the system writes (follow-ups, plan continuations) use it only with “Goal-bound permission” on and inside that goal’s scope.',
    goalGrants: 'Goal-bound permission',
    goalGrantsHint:
      "On: work your own chat message had done at once (the same machine, project and kind of operation) carries over to the continuation turns of that conversation for 6 hours — an approved autonomous plan or a watch follow-up carries on without a new card or approval for the same work. A step outside that scope stops on a card with one reason. Events that ask for a code, roles, the machine's own machine-admin switch and actions that are always cards (backup restore and the like) are unchanged. Turning it off or revoking the conversation's permission ends it at once. Every inherited action is logged.",
    autoExtendTime: 'Extend time automatically',
    autoExtendTimeHint:
      'On: when a job runs low on time and is still making progress (it did something in the last 10 minutes and waits for no one), its limit is extended by itself — by half the limit, at least 30 min, up to the job time maximum — at most 3 times per job. Every extension is logged and the job’s conversation gets an “extended the time automatically” note. Jobs that look stuck are never extended; you decide on those.',
  },
} satisfies Shape<typeof tr>;
