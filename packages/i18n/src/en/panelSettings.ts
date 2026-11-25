import type { Shape } from '../shape.js';
import type tr from '../tr/panelSettings.js';

/**
 * p17-panel-settings (docs/design/p17-panel-settings.md): Settings → Server settings — settings that used to exist only
 * as environment variables (stored by the master; the environment variable stays the default), key rotation and
 * maintenance jobs.
 */
export default {
  page: {
    label: 'Server settings',
    purpose:
      'Settings that used to change only through environment variables: notification channels, search, network, sessions, logs, memory, workflow engine, Coolify protection; key rotation and maintenance jobs.',
  },
  loading: 'Loading the server settings…',
  status: 'the server settings',
  tabs: {
    notifications: 'Notifications',
    search: 'Search',
    network: 'Network',
    sessions: 'Sessions',
    jobs: 'Jobs',
    logs: 'Logs',
    memory: 'Memory',
    workflows: 'Workflow engine',
    ops: 'Coolify protection',
    keys: 'Keys',
    maintenance: 'Maintenance',
  },
  source: {
    panel: 'panel',
    env: 'environment variable',
  },
  sourceLine: (p: { source: string; env: string }) => `Source: ${p.source} (${p.env})`,
  sourceOnly: (p: { source: string }) => `Source: ${p.source}`,
  envDefault: (p: { value: string }) => `Environment value: ${p.value}`,
  envUnset: 'The environment variable is not set',
  restart: 'Needs a restart',
  reset: 'Back to the environment variable',
  save: 'Save',
  saved: 'Saved.',
  stepUp: 'Change the server settings',
  listHint: 'One value per line.',
  on: 'On',
  off: 'Off',
  none: '(none)',
  secret: {
    set: 'Set',
    unset: 'Not set',
    change: 'Change',
    cancelChange: 'Cancel',
    remove: 'Remove',
    generate: 'Generate on the server',
    regenerate: 'Generate again',
    placeholder: 'New value (never shown again)',
    shownOnce: 'This value is shown only now; copy it to the receiving systems now.',
    publicKey: 'Public key',
  },
  confirm: {
    title: 'Confirmation needed',
    clientIp: (p: { current: string; after: string }) =>
      `With these settings the server would see this request from ${p.after} instead of ${p.current}. If that is wrong, sessions and rate limits are affected. Save anyway?`,
    push: (p: { devices: number }) =>
      `A new push key turns push off on ${String(p.devices)} device(s); people turn it on again in Settings → Devices. Continue?`,
    yes: 'Yes, save',
    no: 'Cancel',
  },
  sections: {
    notifications:
      'Webhook allowlist and signing key, Web Push (VAPID) key, subject and push service allowlist.',
    search:
      'The semantic search provider: AWS Bedrock (on the Integrations page) or an HTTP embedding service. SEARCH_PROVIDER=off on the server stays the kill switch.',
    network:
      'Trusted proxy hops and the CDN client-IP header. A wrong setting ties sessions and rate limits to the wrong address.',
    sessions: '"Remember me" and trusted-device lifetimes, approval of machine key rotations.',
    jobs: 'How long a job waits for a runtime login on its machine.',
    logs: 'Retention, level and request lines of the console log search.',
    memory:
      'The global auto-learning switch and thresholds. MEMORY_AUTO_LEARN=off on the server stays the kill switch.',
    workflows: 'Workflow engine 2. Run the pre-check before turning it on.',
    ops: 'Internal origins and protected control-plane resources for Coolify and DNS actions.',
  },
  info: {
    outputsStore: {
      local: 'Large outputs are uploaded to the storage on the server’s disk.',
      s3: 'Large outputs are uploaded to object storage (S3).',
      unavailable:
        'Object storage is selected but not usable right now: jobs use the direct path only. The file limit still applies; files that do not fit are listed with their reason on the job page.',
    },
    outputsBudget: (p: { inlineFile: string; inlineTotal: string; file: string; job: string }) =>
      `A file’s size decides its path: small files come back directly (${p.inlineFile} each, ${p.inlineTotal} in total); larger ones and everything beyond that total go to the storage (${p.file} each, ${p.job} per job; Settings → Integrations → Storage). Files beyond the limit are packed into one out-rest.zip.`,
    outputsOldWorkers:
      'Machines with older software (without output-limits-v1) keep the old limits: 20 files, no zip.',
    clientIp: (p: { ip: string }) => `The client address the server sees for this request: ${p.ip}`,
    socket: (p: { ip: string; xff: string }) => `Connection address: ${p.ip}; X-Forwarded-For: ${p.xff}`,
  },
  fields: {
    'notify.webhook.allowlist': {
      label: 'Webhook allowlist',
      hint: 'https:// URL prefixes people may register as their webhook.',
    },
    'notify.webhook.secret': {
      label: 'Webhook signing key (HMAC)',
      hint: 'Every notification is signed with it (X-Remyral-Signature). Rotate it on the Keys tab.',
    },
    'push.vapidKey': {
      label: 'Web Push key (VAPID)',
      hint: 'Generated on the server; the private half is never shown.',
    },
    'push.subject': {
      label: 'Web Push contact',
      hint: 'A mailto: address or https:// URL the push services see.',
    },
    'push.endpointAllowlist': {
      label: 'Push service allowlist',
      hint: 'Empty: the known browser push services.',
    },
    'search.provider': { label: 'Provider', hint: 'HTTP: an OpenAI-compatible embedding service.' },
    'search.http.url': { label: 'HTTP endpoint', hint: 'https:// (http:// only for this machine).' },
    'search.http.model': { label: 'Model', hint: 'The service’s model name.' },
    'search.http.key': { label: 'API key', hint: 'Stored encrypted, never shown again.' },
    'search.http.dimensions': { label: 'Dimensions', hint: 'Empty: the service’s default.' },
    'net.trustProxyHops': {
      label: 'Trusted proxy hops',
      hint: 'Proxies in front of the server (Traefik: 1; Cloudflare + Traefik: 1 and the header below).',
    },
    'net.clientIpHeader': {
      label: 'Client-IP header',
      hint: 'For example cf-connecting-ip for Cloudflare. Honoured only from the addresses below.',
    },
    'net.clientIpSources': {
      label: 'Addresses trusted for the header',
      hint: 'The CDN’s egress addresses (IP or CIDR).',
    },
    'auth.rememberIdleDays': { label: '"Remember me" idle (days)', hint: '0: "Remember me" off.' },
    'auth.rememberAbsoluteDays': { label: '"Remember me" longest (days)', hint: '0: off.' },
    'auth.trustedDeviceDays': {
      label: 'Trusted device (days)',
      hint: '0: trusted devices off (an authenticator code at every sign-in).',
    },
    'workers.rotationApproval': {
      label: 'Machine key rotation needs approval',
      hint: 'On: a machine’s new key waits until an administrator approves it.',
    },
    'jobs.loginWaitMinutes': {
      label: 'Login wait (minutes)',
      hint: 'A job waits this long for a runtime login on its machine. 0: no wait.',
    },
    'jobs.outputMaxFiles': {
      label: 'Output files per job',
      hint: 'The most files a workspace job may return (direct path and storage together; 1–2000). The rest comes back in one out-rest.zip. Projects may choose a lower value.',
    },
    'logs.retentionDays': { label: 'Retention (days)', hint: '0: the console log search is off.' },
    'logs.level': { label: 'Lowest level', hint: 'Lines below this level are not kept.' },
    'logs.requests': { label: 'Request lines', hint: 'problems: failed requests only; all: every request.' },
    'memory.autoLearn': {
      label: 'Automatic learning',
      hint: 'Off: suggestions wait for a person (the project settings do not apply).',
    },
    'memory.duplicateThreshold': {
      label: 'Duplicate threshold',
      hint: 'A suggestion above this similarity counts as a duplicate of an existing record (0.5–0.999).',
    },
    'memory.chatPerThreadDay': {
      label: 'Suggestions per chat per day',
      hint: '0: no suggestions from chats.',
    },
    'workflow.engineV2': {
      label: 'Workflow engine 2',
      hint: 'Version 2 documents are saved and run on engine 2.',
    },
    'workflow.engineV2ForV1': {
      label: 'Version 1 workflows on engine 2 too',
      hint: 'Run the pre-check first; open runs finish on their own engine.',
    },
    'ops.internalOrigins': {
      label: 'Internal origins',
      hint: 'Exact origins reachable even over http:// or a private address (e.g. http://coolify:8000).',
    },
    'ops.controlPlaneUuids': {
      label: 'Protected Coolify resources',
      hint: 'The uuids of the Remyral control-plane resources: no action ever deploys to them.',
    },
    'ops.controlPlaneAddresses': {
      label: 'Control-plane addresses',
      hint: 'Addresses DNS records must not point at.',
    },
  },
  mail: {
    title: 'E-mail (SMTP)',
    sub: 'Notification e-mail and the support report use the same SMTP setting. Without one in the panel the NOTIFY_SMTP_* environment variables apply.',
    source: {
      panel: 'panel',
      env: 'environment variable',
      none: 'not configured',
    },
    host: 'Server',
    port: 'Port',
    security: 'TLS',
    from: 'Sender',
    username: 'User name',
    password: 'Password',
    passwordSet: 'Password set',
    edit: 'Edit',
    save: 'Save the SMTP setting',
    remove: 'Remove the panel setting',
    testTo: 'Test recipient (empty: your notification address)',
    test: 'Send a test e-mail',
    testOk: (p: { to: string }) => `Test e-mail sent: ${p.to}`,
    testFailed: (p: { error: string }) => `Not sent: ${p.error}`,
  },
  workflowCheck: {
    title: 'Pre-check (workflow:normalise-check)',
    sub: 'A dry run: every stored workflow definition converts to a version 2 document and back unchanged; nothing changes.',
    run: 'Run the pre-check',
    running: 'Running…',
    ok: 'The pre-check passed.',
    failed: (p: { n: number }) =>
      `${String(p.n)} definition(s) failed; fix them before turning the engine on.`,
    needCheck: 'Run the pre-check before moving version 1 workflows to engine 2.',
  },
  keys: {
    title: 'Key rotation',
    sub: 'Every rotation first shows what changes (a dry run), then it is audited.',
    dryRun: 'Show what changes',
    rotate: 'Rotate',
    activate: 'Activate the new key',
    cancel: 'Cancel the rotation',
    age: (p: { days: number }) => `${String(p.days)} days ago`,
    online: 'From the panel',
    host: 'On the server',
    procedure: 'Steps on the server',
    items: {
      webhookHmac: {
        title: 'Webhook signing key',
        sub: 'A new key is prepared and shown once; until you activate it notifications carry two signatures (X-Remyral-Signature-Next) so receivers can switch first.',
      },
      skillsPanel: {
        title: 'Skill signing key (panel)',
        sub: 'Signs the skills written in chat. Generated on the server; its public key reaches the machines through the managed configuration.',
      },
      leaseSigning: {
        title: 'Lease-signing key',
        sub: 'Signs the jobs given to machines and verifies the server applier’s requests.',
      },
      totp: {
        title: 'Master key (TOTP_KEY_FILE)',
        sub: 'Protects authenticator secrets, recovery codes, API tokens and every secret stored in the panel.',
      },
    },
    pending: 'A prepared new key waits to be activated.',
    publicKey: 'Public key',
    retiredKeys: 'Earlier public keys still trusted',
    secretOnce: 'New key (shown only now)',
    effect: 'Effect',
  },
  maintenance: {
    title: 'Maintenance jobs',
    sub: 'They run in the background with visible progress and can be cancelled. One job of each kind at a time. A dry run first.',
    kinds: {
      'blobs-migrate': 'Move stored files (blobs:migrate)',
      'search-backfill': 'Fill missing vectors (search:backfill)',
      'memory-autolearn': 'Memory auto-learning (memory:autolearn)',
    },
    mode: 'Mode',
    modes: {
      legacy: 'Move older rows into storage',
      'to-store': 'Move local files to the chosen storage',
    },
    searchKinds: 'Kinds',
    dryRun: 'Dry run',
    start: 'Start',
    cancel: 'Cancel',
    state: {
      queued: 'Queued',
      running: 'Running',
      done: 'Done',
      failed: 'Failed',
      cancelled: 'Cancelled',
    },
    progress: (p: { done: number; total: string }) => `${String(p.done)} / ${p.total}`,
    report: 'Report',
    none: 'No maintenance jobs yet.',
    stepUp: 'Start the maintenance job',
  },
  recovery: {
    needsLabel: 'Account',
    title: 'Account recovery',
    sub: 'Authenticator reset, password reset and unlock. Each asks for a fresh authenticator code, is audited and notifies the user.',
    resetMfa: 'Reset the authenticator',
    resetMfaBody: (p: { user: string }) =>
      `The authenticator app and recovery codes of ${p.user} are removed, trusted devices and sessions end. They set it up again at the next sign-in.`,
    resetPassword: 'Reset the password',
    resetPasswordBody: (p: { user: string }) =>
      `A one-time password is generated for ${p.user} and shown only now; their sessions end and they choose a new password at the first sign-in.`,
    unlock: 'Unlock',
    unlockBody: (p: { user: string }) => `The failed sign-in lock of ${p.user} is removed.`,
    confirm: 'Yes, apply',
    cancel: 'Cancel',
    reason: 'Reason (kept in the audit trail)',
    tempPassword: 'Temporary password (shown only now)',
    tempPasswordHint: 'Pass it on over a safe channel; they must change it at the first sign-in.',
    done: 'Done.',
    ownerApproval: 'Another owner must approve',
    ownerApprovalBody: (p: { user: string }) =>
      `${p.user} is an owner. With more than one owner, resetting another owner needs a second owner's approval: a request is made and the other owner approves it in Waiting on you.`,
    requested: 'Approval requested; it applies when a second owner approves.',
    approve: 'Approve and apply',
    pendingTitle: 'Recovery requests waiting for approval',
    pendingItem: (p: { action: string; user: string; by: string }) => `${p.by}: ${p.action} for ${p.user}`,
    locked: 'Locked',
    actions: {
      'reset-mfa': 'authenticator reset',
      'reset-password': 'password reset',
      unlock: 'unlock',
    },
    stepUp: (p: { user: string }) => `Recover the account of ${p.user}`,
  },
} satisfies Shape<typeof tr>;
