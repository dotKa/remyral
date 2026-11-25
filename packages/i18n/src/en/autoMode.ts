import type { Shape } from '../shape.js';
import type tr from '../tr/autoMode.js';

export default {
  settings: {
    title: 'Auto mode',
    on: 'On: every approval the policy can grant is granted without asking.',
    off: 'Off: approvals are asked as the rules say.',
    hint: 'Tool approvals, merge decisions, deploys (production too) and MCP tools pass without asking; transient failures are retried by themselves and a fix job opens after a permanent failure. Always asked: machine administration, force push / branch deletes / deletes outside the workspace and the safe core (2FA, the security policy).',
    switchLabel: 'Use auto mode',
    retries: 'Automatic retries',
    retriesOff: 'Off',
    retriesN: (p) => `At most ${String(p.n)} times (1, 5, 20 min apart)`,
    turnedOn: 'Auto mode is on.',
    turnedOff: 'Auto mode is off.',
  },
  job: {
    title: 'Automatic actions',
    retrying: (p) => `Automatic retry ${String(p.n)}/${String(p.max)}`,
    nextAt: (p) => `Next attempt ${p.time}`,
    approved: (p) => `Auto mode approved: ${p.action}`,
    approvedPolicy: (p) => `The security policy approved: ${p.action}`,
    retry: (p) => `Automatic retry ${String(p.n)}/${String(p.max)} (${p.cause})`,
    otherMachine: 'It is tried on another eligible machine.',
    exhausted: (p) => `${String(p.max)} automatic retries failed as well.`,
    baseRef: (p) => `Base ref healed: ${p.from} → ${p.to}`,
    rebased: 'The work was rebased onto the base at job start automatically and verified again.',
    rebaseConflicts: (p) =>
      `The automatic rebase conflicts in ${String(p.n)} file(s); a person (or the fix job) has to resolve them.`,
    rebaseOther: 'The automatic rebase was not possible.',
    repoAccess: {
      repo_credentials_missing:
        'Repository access check: the repository is private (or does not exist) and this job has no git credential; the job was not started on any machine.',
      repo_access_denied:
        'Repository access check: the project’s git connection cannot reach this repository; the job was not started on any machine.',
    },
    repoAccessFix: {
      no_connection:
        'Fix: connect GitHub (Settings → Integrations → GitHub) and pick this repository in the project’s git settings, or add a repository credential to the project.',
      other_repository:
        'Fix: the project’s git connection is set up for another repository; point its git settings at this repository or start the job in the right project.',
      untrusted_source:
        'Fix: jobs from an untrusted source get no git credential; start the job from a trusted source.',
      not_installed:
        'Fix: add this repository to the GitHub App installation (Settings → Integrations → GitHub) or correct the project’s repository URL.',
      connection_refused:
        'Fix: the connection’s permission or token is invalid or expired; reconnect it in Settings → Integrations.',
    },
    fixOpened: 'A fix job was opened.',
    fixDone: (p) => `The fix job ended: ${p.state}`,
    fixLink: 'Open the fix job',
    fixOf: 'This job is the automatic fix job of a failed job.',
    fixOfLink: 'Open the original job',
    conflictResolvable:
      'This job’s result conflicts with its target branch: other work merged meanwhile. Resolve conflicts carries the result onto the current branch without redoing the work.',
    conflictResolve: 'Resolve conflicts',
    conflictResolveStarted: 'A conflict-resolution job was opened.',
    conflictResolveOpened:
      'A conflict-resolution job was opened; when it merges this job closes and the platform closes the old pull request.',
    conflictResolveMerged: (p) =>
      `The conflict-resolution job merged; it supersedes this job.${p.prClosed ? ' The old pull request was closed.' : ''}`,
    conflictResolveFailed: 'The conflict-resolution job ended without merging; this job stays as it is.',
    conflictResolveLink: 'Open the conflict-resolution job',
    conflictResolveOf: 'This job carries a result that conflicted with its target onto the current branch.',
    conflictResolveOfLink: 'Open the original job',
    causes: {
      runtime_crash: 'runtime crashed',
      disk_low: 'disk full',
      git_auth: 'git authentication',
      git_network: 'network error',
      git_cache: 'the machine’s git cache',
      login: 'runtime login',
      worker_restart: 'machine restarted',
      provider_error: 'provider error',
      lease_lost: 'machine connection lost',
      publish_missing: 'result not published',
      usage_limit: 'usage limit',
      base_ref: 'base ref missing',
      diverged: 'diverged from the base',
      policy: 'policy refusal',
      invalid: 'invalid request',
      timeout: 'time limit exceeded',
      cancelled: 'cancelled',
      verification: 'verification',
      run_failed: 'run failed',
    },
    reasons: {
      previous_job_head: 'the previous job’s result',
      previous_job_target: 'the branch the previous job merged into',
      project_base: 'the project’s base branch',
      repository_default: 'the repository’s default branch',
    },
    fixStates: {
      created: 'running',
      succeeded: 'succeeded',
      failed: 'failed',
      cancelled: 'cancelled',
      skipped: 'not opened',
    },
  },
  digest: {
    line: (p) =>
      `Last 24 hours: ${String(p.failed)} failed · ${String(p.healed)} healed by themselves · ${String(p.waiting)} waiting for you`,
    link: 'Failed jobs',
  },
} satisfies Shape<typeof tr>;
