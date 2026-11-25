import { plural } from '../plural.js';
import type { Shape } from '../shape.js';
import type tr from '../tr/machineAdmin.js';

const jobs = (n: number): string => `${String(n)} ${plural('en', n, { one: 'job', other: 'jobs' })}`;
const parallelJobs = (n: number): string =>
  `${String(n)} parallel ${plural('en', n, { one: 'job', other: 'jobs' })}`;

/** p14-i18n-screens-b (i18n Phase 5): Machine → Admin, Activity and Overview → Capacity. */
export default {
  cancel: 'Cancel',
  details: 'Details',
  close: 'Close',
  configuration: 'Configuration',
  stepUp: (p) => `${p.machine}: ${p.what} — enter a current authenticator code.`,
  opState: {
    sent: 'Sent',
    accepted: 'Started',
    running: 'Running',
    waiting_for_user: 'Waiting for you',
    succeeded: 'Succeeded',
    failed: 'Failed',
    refused: 'Refused',
    lost: 'Lost',
    cancelled: 'Cancelled',
  },

  lifecycle: {
    title: 'Access',
    sub: "The machine's device key and whether it takes new jobs. Every action asks for a current authenticator code.",
    none: 'There is no access action to take on this machine right now.',
    archiveConfirm: (p) =>
      `Remove ${p.machine} from the machine list? Nothing is deleted: its history and audit trail stay, and its device key stays refused. You can show archived machines and unarchive it later.`,
    actionsLabel: 'Access actions',
    deviceKeys: 'Device keys',
    actions: {
      drain: {
        label: 'Drain',
        hint: 'Finishes the running jobs, then takes no new ones.',
        confirm: 'Confirm drain',
      },
      rotate: {
        label: 'Rotate key',
        hint: 'The machine creates a new device key; you approve it here.',
      },
      approveRotation: {
        label: 'Approve new key',
        hint: 'The machine asked to change its device key.',
      },
      revoke: {
        label: 'Revoke key',
        hint: 'Refuses the device key for good. The machine has to be paired again.',
        confirm: 'Confirm revoke',
      },
      archive: {
        label: 'Remove from list',
        hint: 'Hides it from the list. History and the audit trail stay.',
        confirm: 'Confirm removal',
      },
      unarchive: {
        label: 'Unarchive',
        hint: 'Shows the machine in the list again.',
      },
    },
    keyState: {
      active: 'Active',
      pending: 'Awaiting approval',
      revoked: 'Revoked',
      superseded: 'Superseded',
    },
  },

  restart: {
    title: 'Restart the machine service',
    sub: 'The machine service restarts through its service manager; the device key and configuration stay the same.',
    loading: 'Loading restart status',
    notManaged:
      "The machine service doesn't run under a service manager; if it were restarted, it couldn't come back on its own.",
    unsupported: "The Remyral version on this machine can't be restarted remotely. Update it first.",
    why: 'Restart the machine service — enter a current authenticator code.',
    drain: 'Wait for running jobs first (no new jobs start meanwhile)',
    giveUp: 'Give up after this many minutes',
    stopNote: 'Running jobs are stopped; the master reconciles them after the restart.',
    notConnected: "The machine isn't connected; you can restart it once it connects.",
    button: 'Restart the machine service',
    confirm: 'Confirm restart',
    op: 'Restart',
  },

  admin: {
    title: 'Machine administration',
    intro:
      'An AI agent running commands on this machine as root / Administrator. The master signs, records and audits every command.',
    loading: 'Loading machine administration',
    unsupported:
      "The Remyral version on this machine can't run machine administration; update the machine first (Settings → releases).",
    status: 'Status',
    ownerOnly: 'Only an owner can turn machine administration on or off.',
    on: 'On',
    off: 'Off',
    autoApproveOn: 'full access allowed (commands of jobs that allow everything run without approval)',
    autoApproveOff: 'every privileged command asks for approval',
    helper: 'Privileged helper',
    helperInstalled: 'Available',
    helperMissing: 'Unavailable',
    helperUnknown: 'Unknown',
    helperReason: {
      install_dir_unknown: 'The worker does not know its install folder.',
      helper_missing: 'No privileged helper is installed (installed without the signed updater).',
      helper_outdated:
        'The installed privileged helper predates machine administration; re-run the installer kit of this release once as admin / root.',
      admin_unit_missing:
        'The systemd trigger of admin sessions (remyral-worker-admin.path) is not installed; re-run the installer kit once as root.',
      admin_unit_disabled:
        'The systemd trigger of admin sessions (remyral-worker-admin.path) is not enabled; re-run the installer kit once as root.',
      state_dir_not_traversable:
        'The worker account cannot reach the helper’s answer folder (state/machine-admin); re-run the installer kit of this release once as root.',
      admin_task_missing:
        'The scheduled task of admin sessions (RemyralWorkerAdmin) was not found; re-run the installer kit once as Administrator.',
      admin_task_unreadable:
        'The scheduled task of admin sessions (RemyralWorkerAdmin) could not be queried.',
      admin_plist_missing:
        'The LaunchDaemon of admin sessions (com.remyral.worker.admin) is not installed; re-run the installer kit once as admin.',
      probe_failed: 'The readiness check did not finish.',
      helper_not_bound:
        'Machine administration is not yet bound to this machine’s worker, so the helper refuses every session. Run this once on the machine as root / Administrator (or re-run the installer kit), after comparing the printed fingerprint with this page:',
      helper_bound_elsewhere:
        'The helper on this machine serves another worker id (was the machine paired again?). After comparing the fingerprint with this page, run this once on the machine as root / Administrator:',
      host_unconfined:
        'Host jobs on this machine run without filesystem confinement, so the helper refuses machine administration. Enable confinement (Sandbox tab), or allow it explicitly in the machine’s local config (localCeiling.allowMachineAdmin: true).',
    },
    runningJob: 'Running job',
    notReported: "The machine hasn't reported its machine administration state yet.",
    vetoBefore: "The machine's local configuration forbids machine administration (",
    vetoAfter: '); the panel setting has no effect there.',
    notApplied: "The machine hasn't applied the change yet.",
    switchWhy: (p) =>
      `Turn machine administration ${p.enable ? 'on' : 'off'} on ${p.machine} — enter a new authenticator code.`,
    warningTitle: 'Before you turn this on',
    warning: (p) =>
      `Machine administration lets an AI agent run commands on ${p.machine} as root / Administrator / SYSTEM: installing and removing software, services, users, the firewall and system files. The master signs, records and audits every command for a single job, and asks a human to approve it unless full access is on below and in the Machines project. A command injection in content the agent reads could try to abuse this — only approve commands you understand. The machine's local configuration can block it. Owners are notified of every change.`,
    autoApprove: 'Allow full access (privileged commands of jobs that allow everything run without approval)',
    autoApproveHint:
      'The Machines project also needs “allow auto-approval” (Projects → machines → Policy). Every command is still recorded.',
    projectNoteBefore:
      "The Machines project doesn't allow auto-approval yet: until an admin turns it on under",
    projectNoteLink: 'Projects',
    projectNoteAfter: ', commands still ask for approval.',
    disable: 'Turn off machine administration',
    saveAutoApprove: 'Save full access setting',
    enable: 'Turn on machine administration…',
    enableConfirm: 'I understand — turn on machine administration',
    taskTitle: 'New machine task',
    taskSub: 'Tell the agent what to do on this machine. The task opens as an ordinary job.',
    taskForm: (p) => `New machine task on ${p.machine}`,
    taskWhy: (p) => `Start a machine administration job on ${p.machine} — enter a new authenticator code.`,
    taskName: 'Title',
    taskPrompt: 'What should the agent do on this machine?',
    approvals: 'Approvals',
    askAll: 'Ask for every privileged command (recommended)',
    allowAll: 'Full access — no approvals',
    maxMinutes: 'Maximum duration (minutes)',
    noFullAccess:
      "Full access isn't allowed for this machine or the Machines project; every command asks for approval.",
    startTask: 'Start machine task',
    started: 'Started.',
    taskLink: 'Machine task',
    commandsTitle: 'Recent privileged commands',
    commandsNone: 'No privileged command has run on this machine yet.',
    commandsLabel: 'Privileged commands',
    autoApproved: 'ran without approval',
    exitCode: (p) => `exit ${String(p.code)}`,
    commandDetails: (p) => `${p.summary}: details`,
    commandJob: "The command's job",
    purpose: 'Purpose (the agent’s explanation, not verified)',
    fileLine: (p) =>
      `${p.path} · ${String(p.bytes)} ${plural('en', p.bytes, { one: 'byte', other: 'bytes' })} · sha256 ${p.before ?? 'new'} → ${p.after ?? '—'}`,
    output: 'Output',
    truncated: '[truncated]',
    cmdState: {
      requested: 'Requested',
      pending: 'Awaiting approval',
      granted: 'Granted',
      denied: 'Denied',
      succeeded: 'Succeeded',
      failed: 'Failed',
      refused: 'Refused',
    },
    kind: {
      exec: 'Command',
      write_file: 'File write',
      read_file: 'File read',
    },
    memoryTitle: 'Machine memory',
    memoryUpdated: (p) => `updated ${p.at}`,
    memorySub:
      'What earlier machine administration jobs installed or changed; every new job on this machine reads it.',
    memoryWhy: 'Saving the machine memory needs a current authenticator code.',
    memorySave: 'Save memory',
    memoryEmpty: 'Nothing saved yet.',
    memoryEdit: 'Edit memory',
  },

  activity: {
    historyTitle: 'History',
    historySub: 'Pairing, connections, key changes and updates; newest first.',
    historyLoading: 'Loading history',
    historyEmpty: 'No events yet.',
    more: (p) => `Show more (${String(p.n)})`,
    action: {
      pairingRequest: 'Pairing requested',
      approve: 'Approved',
      deny: 'Registration denied',
      sessionStart: 'Connected',
      sessionEnd: 'Disconnected',
      drain: 'Drain requested',
      revoke: 'Key revoked',
      archive: 'Removed from list',
      unarchive: 'Back in the list',
      rotateRequest: 'Key rotation requested',
      rotate: 'Key rotated',
      rotateApprove: 'New key approved',
      runtimePolicyAssign: 'Runtime policy assigned',
      updateOffer: 'Update offered',
      updateTarget: 'Update target set',
    },
    outcome: {
      failure: 'failed',
      denied: 'denied',
      error: 'error',
    },
  },

  ops: {
    title: 'Remote operations',
    loading: 'Loading operations',
    unsupportedTitle: "The Remyral version on this machine can't send logs and diagnostics remotely",
    unsupported: 'Update the machine first (Settings → releases).',
    logsTitle: 'Machine logs',
    logsSub: 'Fetched from the machine on request; masked on the machine and shown as plain text only.',
    logLabel: 'Machine log',
    lines: (p) => `${String(p.n)} ${plural('en', p.n, { one: 'line', other: 'lines' })}`,
    noLines: 'No lines yet.',
    logWhy: (p) => `${p.machine}: fetch the ${p.source} log`,
    log: 'Log',
    source: {
      worker: 'machine service',
      boot: 'boot',
      updater: 'updater',
    },
    sourceOption: {
      worker: 'Machine service',
      boot: 'Boot (startup errors)',
      updater: 'Updater',
    },
    lineCount: 'Lines',
    fetch: 'Fetch log',
    needsConnection: 'Logs and diagnostics need a connected machine.',
    logTruncated: 'Older lines were left out (line / size limit).',
    diagTitle: 'Diagnostics',
    diagSub:
      'Machine version, Node, operating system, memory and disk, sandbox profiles, runtimes and problems found.',
    diagWhy: (p) => `${p.machine}: run diagnostics`,
    diagRun: 'Run diagnostics',
    diagNotRun: 'Not run yet.',
    historyTitle: 'Remote operations',
    opCount: (p) => `${String(p.n)} ${plural('en', p.n, { one: 'operation', other: 'operations' })}`,
    historySub: 'Installs, logins, restarts, logs and diagnostics requested on this machine.',
    historyEmpty: 'No operations yet.',
  },

  diag: {
    disk: 'Disks',
    version: 'Version',
    system: 'System',
    service: 'Service',
    memory: 'Memory',
    nodeOk: 'OK',
    nodeNeeds: (p) => `${String(p.major)}+ required`,
    memoryFree: (p) => `${p.free} free of ${p.total}`,
    diskFree: (p) => `${p.name} ${p.free} free`,
    sandboxProfiles: 'Sandbox profiles',
    ready: 'ready',
    notReady: 'not ready',
    runtimes: 'Runtimes',
    runtimeLine: (p) =>
      `${p.version ?? 'not found'} (${p.source}${p.enabled ? ', enabled' : ''}, login ${p.auth}${p.integrity === null ? '' : `, integrity ${p.integrity}`})`,
    noProblems: 'No problems found.',
  },

  capacity: {
    title: 'Capacity',
  },

  advice: {
    title: 'Parallel jobs',
    recommended: (p) =>
      `Recommended: ${parallelJobs(p.n)} — ${String(p.cpus)} CPUs, ${p.ram} RAM, ${p.runtime} uses ${p.estimated ? 'an estimated' : 'typically at most'} ~${p.peak}`,
    peakMeasured: (p) => `measured on this machine over ${jobs(p.n)}`,
    peakFleet: 'measured on other machines',
    peakEstimateSome: (p) => `estimate (only ${jobs(p.n)} measured here so far)`,
    peakEstimateNone: 'estimate; no job measured yet',
    panel: (p) => `Runs ${p.n} jobs at a time, as the panel configuration says.`,
    localCeiling: (p) =>
      `Runs ${p.n} jobs at a time: the panel configuration says ${p.configured}, but the machine's local config file caps it at ${p.ceiling} (localCeiling.maxParallelJobs or maxParallelJobs). Only someone on the machine can raise it.`,
    pending: (p) =>
      `Runs ${p.n} jobs at a time from the local config file; ${p.configured} from the panel configuration isn't applied yet.`,
    localFile: (p) =>
      `Runs ${p.n} jobs at a time from the local config file (default 1); not managed from the panel.`,
    unknown: "The machine hasn't reported how many jobs it runs at a time yet.",
    why: (p) => parallelJobs(p.n),
    saved: (p) => `Saved: ${parallelJobs(p.n)}. The machine applies it when it connects.`,
    cpuLimited: (p) =>
      `CPU is the limit (2 jobs per core, one slot kept free). Memory would allow ${jobs(p.byMemory)}.`,
    memoryLimited: (p) =>
      `Memory is the limit: ${p.usable} usable after reserving ${p.reserve}, counted at ${p.perJob} per job.`,
    peakLine: (p) => `${p.runtime}: ${p.source}.`,
    none: "No recommendation: the machine hasn't reported its CPU and memory.",
    auto: (p) =>
      `Automatic capacity is on: the master currently sends at most ${parallelJobs(p.slots)}; the configured ${p.configured} is only the upper limit. See Capacity mode below.`,
    above: (p) =>
      `${p.managed ? 'The panel configuration asks for' : 'The machine runs'} ${parallelJobs(p.n)}, more than the recommended ${String(p.recommended)}. Jobs may compete for memory and slow the machine down or fail.`,
    ceilingBelow: (p) =>
      `The machine's local config file caps this at ${String(p.ceiling)}; applying the recommendation can't go above it.`,
    apply: (p) => `Apply ${parallelJobs(p.n)}`,
    applyNote: "Writes to the machine's panel configuration.",
    unmanaged: (p) =>
      `To apply it, take over this machine's configuration on the Configuration tab and set ${parallelJobs(p.n)}.`,
  },

  caches: {
    title: 'Package caches',
    sub: 'Shared only by trusted jobs running on the machine; never by untrusted sources or container jobs.',
    changeLimit: 'Change limit',
    notReported: 'Not reported: the machine runs a version without shared package caches.',
    offLocal: "Off: the machine's local config file turns package caches off (packageCaches.enabled).",
    offZero: 'Off: the size limit is 0.',
    summary: (p) =>
      `${p.used} of the ${p.max} limit in use (${p.pct}), ${String(p.projects)} ${plural('en', p.projects, { one: 'project', other: 'projects' })}.`,
    meter: 'Cache usage',
    projects: 'Projects with a cache',
    inUse: 'in use',
    lastUsed: (p) => `last used ${p.at}`,
    truncated: 'Only the largest projects are listed.',
    noEviction: 'Nothing evicted yet.',
    eviction: (p) =>
      `Last eviction ${p.at}: ${String(p.projects)} least recently used project ${plural('en', p.projects, { one: 'cache', other: 'caches' })}, ${p.bytes}.`,
    scanned: (p) => ` Sizes as of ${p.at}.`,
    projectPolicy: 'A project can turn caches off in its execution policy.',
  },

  disk: {
    title: 'Disk cleanup',
    sub: 'The machine deletes only files it created itself and can recreate; never user data, Docker images or git mirrors.',
    onPill: 'On',
    offPill: 'Off',
    cleanNow: 'Clean now',
    why: (p) => `Disk cleanup on ${p.machine}`,
    what: 'Disk cleanup',
    notSupported: 'This machine version cannot clean its own disk; update the machine.',
    notReported: 'Not reported yet.',
    offline: 'The machine is offline: a cleanup can start once it connects.',
    on: (p) =>
      `On: cleans by itself when free space falls below ${p.target} (minimum free disk ${p.threshold} + margin ${p.margin}).`,
    off: 'Off: the machine does not clean by itself. “Clean now” still works.',
    free: (p) => `Free: ${p.free} (${p.at}).`,
    noRun: 'No cleanup yet.',
    lastRun: (p) => `Last cleanup ${p.at} (${p.trigger}): ${p.freed} freed.`,
    trigger: { low_disk: 'disk low', daily: 'daily', manual: 'manual' },
    freedLabel: 'Space freed',
    category: {
      temp: 'Temporary folders of finished jobs',
      logs: 'Old logs',
      releases: 'Downloaded releases',
      workspaces: 'Expired working folders',
      runtimes: 'Unused runtime versions',
      packageCaches: 'Package caches',
    },
    items: (p) => `${String(p.n)} ${plural('en', p.n, { one: 'item', other: 'items' })}`,
    skipped: (p: { n: number }) =>
      `${String(p.n)} item(s) belong to another account (per-job accounts’ folders); left in place, not an error.`,
    errors: (p) =>
      `${String(p.n)} ${plural('en', p.n, { one: 'item', other: 'items' })} could not be deleted (see the machine's log).`,
    stillLow:
      'Free space is still below the target after the cleanup: nothing the machine may delete is left. What uses the space is below.',
    nextDaily: (p) => `Next daily cleanup ${p.at}.`,
    nextLowDisk: (p) => `Next automatic cleanup not before ${p.at}.`,
    changeSettings: 'Change settings',
    usageTitle: (p) => `Space used (${p.at})`,
    usageData: 'Machine data',
    usageWorkspace: 'Workspace root',
    usageName: { 'workspace-root': 'workspace root', other: 'other' },
    usagePartial: 'Sizes are at least this much: the scan reached its limit.',
  },

  slots: {
    title: 'Slots and the Urgent reserve',
    sub: 'Slots kept for Urgent jobs; normal and background jobs see the rest.',
    slots: (p) => `${String(p.n)} ${plural('en', p.n, { one: 'slot', other: 'slots' })}`,
    profile: {
      'host-restricted': 'on the machine',
      'runtime-sandbox': 'runtime sandbox',
      container: 'container',
      unconfined: 'unconfined',
    },
    exclusive: (p) => ` · ${p.profiles} run alone (no isolation between attempts)`,
    noReserve: 'No slot is kept for Urgent jobs on this machine.',
    reserve: (p) =>
      `${String(p.n)} ${plural('en', p.n, { one: 'slot is', other: 'slots are' })} kept for Urgent jobs.`,
    defaultMark: ' (default)',
    reserveLabel: 'Urgent reserve',
    reserveDefault: 'Default (1 from 3 slots up)',
    save: 'Save reserve',
    why: (p) => `Change the Urgent reserve of ${p.machine} — enter a current authenticator code.`,
    saved: 'Urgent reserve saved.',
    note: 'By default a slot is kept only on machines with at least three slots; a machine with two slots runs two normal jobs. A child job (or integration job) of a job already running on this machine can always use the reserved slot, so a job never waits for its own child.',
  },

  mode: {
    title: 'Capacity mode',
    modes: {
      manual: {
        label: 'Manual',
        hint: 'Runs what the configuration says. Nothing is measured or changed.',
      },
      suggest: {
        label: 'Suggest',
        hint: 'Measures the machine and suggests a value (with a notification). You decide.',
      },
      auto: {
        label: 'Automatic',
        hint: 'The master raises or lowers the number of parallel jobs it sends one at a time, within your limits.',
      },
    },
    upperHardware: 'hardware ceiling (CPU and memory per job)',
    upperMachine: "the machine's own limit (local config file or a configuration not applied yet)",
    upperYours: 'your upper limit',
    sentenceManual: (p) => `Manual: runs ${p.n} jobs at a time, as configured.`,
    sentenceSuggest: (p) =>
      `Suggest: runs ${p.n} jobs at a time, as configured; the master measures and suggests, nothing changes on its own.`,
    sentenceAuto: (p) =>
      `Automatic: currently ${parallelJobs(p.slots)}, between ${String(p.min)} and ${String(p.max)}; upper limit ${String(p.upper)} — ${p.reason}.`,
    decision: {
      raise: 'Raised',
      lower: 'Lowered',
      clamp: 'Clamped to the limits',
      hold: 'Holding',
    },
    event: {
      raise: 'Raised',
      lower: 'Lowered',
      clamp: 'Clamped to the limits',
      suggest: 'Suggested',
      mode: 'Mode changed',
      bounds: 'Limits changed',
      override: 'Manual value',
    },
    metric: {
      cpu: (p) => `CPU ${String(p.pct)}%`,
      memoryFree: (p) => `${p.free} free${p.total === null ? '' : ` of ${p.total} memory`}`,
      swap: (p) => `swap ${p.used} / ${p.total}`,
      swapIn: (p) => `swap-in ${String(p.n)}/s`,
      commit: (p) => `commit ${String(p.pct)}%`,
      pressure: (p) => `memory stall ${String(p.pct)}%`,
      running: (p) => `${String(p.n)} running`,
      waiting: (p) => `${String(p.n)} waiting for a slot`,
      oom: (p) => `${jobs(p.n)} out of memory`,
      timeouts: (p) => `${jobs(p.n)} timed out`,
    },
    chartLabel: (p) =>
      `Parallel jobs over time: from ${p.from} to ${p.to}, ${String(p.n)} ${plural('en', p.n, { one: 'change', other: 'changes' })} recorded.`,
    now: 'now',
    legend: (p) =>
      `Line: parallel jobs in effect${p.auto ? '; dashed: upper limit' : ''}${p.dots ? '; dots: suggestions' : ''}.`,
    closed:
      "Manual: runs what the machine's configuration says. The master can measure it and suggest a value, or set it itself within limits you choose.",
    setUp: 'Set up',
    loading: 'Loading capacity',
    boundsError: 'Enter whole numbers: 1 ≤ minimum ≤ maximum ≤ 64.',
    why: (p) => `capacity mode ${p.mode}`,
    savedAuto: (p) =>
      `Saved: automatic between ${String(p.min)} and ${String(p.max)}. The machine's configuration now allows ${jobs(p.max)}; the master sends at most the automatic value.`,
    savedMode: (p) => `Saved: ${p.mode} mode.`,
    metricsMissing:
      "The Remyral version on this machine doesn't send capacity measurements (CPU on Windows; free memory, swap and memory pressure on macOS). Update the machine; until then automatic mode only lowers on failures and never raises.",
    suggestion: (p) =>
      `Suggestion: ${parallelJobs(p.n)}${p.current === null ? '' : ` (currently ${String(p.current)})`}`,
    noSuggestion: 'No suggestion yet: the master needs 10 minutes of measurements.',
    reasons: 'Why',
    measured: (p) => `Measured${p.at === null ? '' : ` ${p.at}`}:`,
    howTitle: 'How automatic capacity decides',
    how1: "It never goes above your upper limit, the hardware ceiling or the machine's own limit, nor below your lower limit.",
    how2: 'Under pressure — little free memory, swapping, high commit, CPU saturation, a job running out of memory or repeated timeouts — it lowers by one right away (at most once a minute).',
    how3: 'It raises by one only while jobs wait for a slot here, every slot is busy and the machine has had headroom for 5 minutes; 10 minutes after any change, 30 minutes after a decrease.',
    how4: 'Running jobs are never stopped: a lower value only means fewer new jobs.',
    how5: 'Changing the number of parallel jobs by hand (Configuration, Apply) turns automatic mode off.',
    historyLabel: 'Capacity history',
    byAdmin: 'an admin',
    byMaster: 'the master',
    modeLegend: 'Mode',
    min: 'Minimum',
    max: 'Maximum',
    hardwareCeiling: (p) => `Hardware ceiling ${String(p.n)}`,
    autoUnmanaged:
      'Automatic capacity needs a machine managed from the panel: take over its configuration on the Configuration tab first. Suggest mode works without it.',
    save: 'Save capacity mode',
  },
} satisfies Shape<typeof tr>;
