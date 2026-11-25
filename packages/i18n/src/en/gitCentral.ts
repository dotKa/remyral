import type { Shape } from '../shape.js';
import type tr from '../tr/gitCentral.js';

/**
 * p15-git-central: "Git readiness" — the machine page's Git card, the fleet-wide fix, Projects → Repository →
 * repository credential (non-GitHub / SSH repositories) and the note that the git identity applies to every commit.
 */
export default {
  card: {
    title: 'Git',
    sub: 'git on this machine and the machine account’s git settings. Jobs do not use these settings: the platform provides the credential and the git configuration of every job.',
    loading: 'Loading git status',
    gitPresent: (p) => `git ${p.version}`,
    gitMissing: 'git not found',
    sources: {
      config: 'git from the configuration',
      managed: 'git installed by Remyral',
      system: 'system git',
    },
    isolated:
      'Jobs do not use the machine’s git settings, credential helpers or gh login; every job runs with its own git configuration.',
    notIsolated: (p) =>
      `This git version cannot keep the machine’s global settings away from jobs; git ${p.min} or newer is needed.`,
    noProblems: 'No problems.',
    notReported: 'This machine has not reported its git status yet.',
    unsupported: 'This machine’s version does not report its git status; update the machine.',
    offline: 'The machine is not connected; fixing is possible once it connects.',
    checkedAt: (p) => `Last check: ${p.at}`,
    osStoreUnchecked: 'The operating system’s credential store could not be checked on this machine.',
    severity: {
      blocking: 'Blocking',
      warning: 'Warning',
      info: 'Info',
    },
    codes: {
      git_missing: 'No git: repository jobs cannot run on this machine. Install git from the Tools tab.',
      git_too_old: (p) =>
        `git is too old: the machine’s global settings cannot be kept away from jobs. Install git ${p.min} or newer.`,
      global_credential_helper: (p) =>
        `${String(p.n)} credential ${p.n === 1 ? 'helper is' : 'helpers are'} configured (${p.helpers}). Jobs do not use them.`,
      global_insteadof: (p) =>
        `${String(p.n)} global URL ${p.n === 1 ? 'rewrite' : 'rewrites'} (insteadOf) change github.com addresses. Jobs ignore them; they confuse manual work.`,
      insteadof_with_credentials: (p) =>
        `${String(p.n)} URL ${p.n === 1 ? 'rewrite carries' : 'rewrites carry'} a password or token in the address. The value is not shown; remove it.`,
      safe_directory_wildcard:
        'safe.directory=* is set: git’s repository ownership protection is off for this account.',
      autocrlf_true:
        'core.autocrlf=true: jobs use their own setting (false); this only affects manual work on the machine.',
      credential_store_file: 'A plain-text credential file (~/.git-credentials) exists.',
      os_store_github: (p) =>
        `The operating system’s credential store holds ${String(p.n)} old GitHub ${p.n === 1 ? 'login' : 'logins'} (Windows Credential Manager / macOS keychain).`,
      global_identity:
        'A global user.name / user.email is set: ignored, commits use the project or workspace identity.',
    },
    fixes: {
      erase_github_credentials: 'Delete old GitHub logins',
      remove_github_insteadof: 'Remove github.com rewrites',
    },
    fix: 'Fix',
    fixWhy: (p) => `Fix the git settings of machine ${p.machine} — enter a current verification code.`,
    fixWillApply: (p) => `Fix will: ${p.fixes}.`,
    what: 'Git fix',
    outcomes: {
      applied: 'done',
      nothing_to_do: 'not needed',
      failed: 'failed',
      unsupported: 'not supported',
    },
    result: (p) => `${p.fix}: ${p.outcome}`,
  },
  fleet: {
    title: 'Git readiness',
    sub: 'git and the machine accounts’ git settings on every machine. A fix goes to each machine as its own signed remote operation.',
    loading: 'Loading the machines’ git status',
    machine: 'Machine',
    git: 'git',
    problems: 'Problems',
    none: 'No machines.',
    ok: 'Ready',
    problemCount: (p) => `${String(p.n)} ${p.n === 1 ? 'problem' : 'problems'}`,
    fixable: (p) => `${String(p.n)} ${p.n === 1 ? 'machine has' : 'machines have'} fixable problems.`,
    nothingFixable: 'No machine has a fixable problem.',
    fixAll: 'Fix everywhere',
    fixAllWhy: 'Fix the git settings of all machines — enter a current verification code.',
    sent: (p) =>
      `Sent to ${String(p.sent)} ${p.sent === 1 ? 'machine' : 'machines'}, ${String(p.skipped)} skipped.`,
    skipped: {
      worker_update_required: 'update needed',
      worker_offline: 'not connected',
      nothing_to_fix: 'no problems',
      rate_limited: 'too many requests',
      default: 'skipped',
    },
  },
  repo: {
    title: 'Repository access (non-GitHub / SSH)',
    sub: 'A project credential for a repository the GitHub App does not cover. The value stays in the vault, sealed to the machines you choose; it is given only to this project’s jobs and only during fetch and push. No permanent SSH key is put on machines.',
    loading: 'Loading repository access',
    githubNote:
      'GitHub repositories need nothing here: every job gets a new token for that repository alone from the GitHub App right before each fetch and push.',
    none: 'Not set.',
    kind: 'Kind',
    kinds: {
      'ssh-key': 'SSH deploy key',
      'https-token': 'HTTPS token',
    },
    credential: 'Credential',
    credentialHint:
      'A credential of kind “Git SSH deploy key” or “Git HTTPS token” created in Settings → Credentials and sealed to the machines that will run this project’s jobs.',
    noCredentials: 'No credential of this kind. Create one in Settings → Credentials first.',
    pick: 'Choose',
    username: 'Username',
    usernameHint: 'The username sent with the token (GitLab: oauth2, Bitbucket: x-token-auth). Empty: git.',
    knownHosts: 'Pinned known_hosts lines',
    knownHostsHint:
      'The server’s key, as ssh-keyscan prints it ("host key-type key"). Verify the fingerprint with the server’s administrator; connections are made only with this key.',
    knownHostsProblems: {
      empty: 'At least one known_hosts line is needed.',
      too_long: 'The known_hosts lines are too long (at most 16 KiB).',
      too_many_lines: 'At most 16 lines.',
      bad_line: 'A line is not valid: "host key-type key" without markers, wildcards or negations.',
    },
    access: 'Permission at the repository',
    accessRead: 'Read only',
    accessWrite: 'Read and write',
    accessHint:
      'Jobs from untrusted sources (for example outside pull requests) only get a credential marked “Read only”.',
    current: (p) => `${p.name} (${p.kind})`,
    workers: (p) => `Machines holding this credential: ${p.names}`,
    noWorkers: 'This credential is not sealed to any machine; jobs cannot fetch.',
    oldWorkers: (p) =>
      `These machines run a version that cannot use this credential: ${p.names}. Update them.`,
    save: 'Save',
    remove: 'Remove',
    saved: 'Repository access saved; the next jobs fetch and push with it.',
    removed: 'Repository access removed.',
    why: (p) => `Change the repository access of project ${p.project} — enter a current verification code.`,
    readOnly: 'Only project owners and admins can change this.',
    edit: 'Change',
    set: 'Set up',
    cancel: 'Cancel',
  },
  vault: {
    kinds: {
      gitSshKey: 'Git SSH deploy key',
      gitHttpsToken: 'Git HTTPS token',
    },
    keyValue: 'Private key',
    keyHint:
      'An OpenSSH private key without a passphrase (-----BEGIN OPENSSH PRIVATE KEY-----). It is sealed in this browser only; the plain value is never sent anywhere.',
    keyProblems: {
      not_a_private_key:
        'Not a private key: paste the whole text starting with -----BEGIN … PRIVATE KEY-----.',
      encrypted:
        'The key has a passphrase; machines cannot ask for it. Use a deploy key without a passphrase.',
    },
    gitOnly:
      'Used only by the platform’s git (fetch and push); never put into a job’s environment. Delivered only to machines on a current version.',
  },
  identity: {
    appliesEverywhere:
      'This identity applies to every commit, the platform’s and the agent’s own. The machines’ global git user.name / user.email settings are ignored.',
  },
} satisfies Shape<typeof tr>;
