import type { Shape } from '../shape.js';
import type tr from '../tr/doctor.js';

/**
 * p16-doctor: Settings → Diagnostics — doctor runs, machine doctors, the support report (preview, download, e-mail) and
 * the support settings; the chat card (draft_support_report). Finding texts by check + code.
 */
export default {
  page: {
    label: 'Diagnostics',
    purpose:
      'Check the control plane and the machines in one click; when something is wrong, download a redacted report or send it to support.',
    docTitle: 'Diagnostics · Remyral',
  },
  loading: 'Loading diagnostics',
  what: 'the diagnostics',
  run: {
    title: 'Doctor',
    sub: 'Database, Redis, migrations, disk, queue, machines, key lifetimes, integrations, chat, backups, recent errors.',
    button: 'Run diagnostics',
    machines: 'Also check the machines (every connected machine runs its doctor, ~20 s)',
    never: 'Diagnostics have not run yet.',
    last: (p: { ago: string; kind: string }) => `Last run ${p.ago} (${p.kind})`,
    daily: (p: { ago: string; n: number }) =>
      p.n === 0
        ? `Daily check ${p.ago}: no new problem`
        : `Daily check ${p.ago}: ${String(p.n)} new ${p.n === 1 ? 'problem' : 'problems'}`,
    dailyNever: 'The daily check has not run yet (once a day; it notifies only about new problems).',
    kinds: { manual: 'by hand', daily: 'daily', chat: 'chat' },
    showPassed: 'Show passed checks too',
    hidePassed: 'Hide passed checks',
    allOk: 'No problem found.',
    fix: 'Fix',
    open: 'Open',
    guide: 'Guide',
  },
  summary: {
    error: (p: { n: number }) => `${String(p.n)} ${p.n === 1 ? 'error' : 'errors'}`,
    warning: (p: { n: number }) => `${String(p.n)} ${p.n === 1 ? 'warning' : 'warnings'}`,
    info: (p: { n: number }) => `${String(p.n)} ${p.n === 1 ? 'note' : 'notes'}`,
    ok: (p: { n: number }) => `${String(p.n)} passed`,
  },
  severity: { ok: 'Passed', info: 'Note', warning: 'Warning', error: 'Error' },
  checks: {
    db_reachable: 'Database',
    redis_reachable: 'Redis (cache)',
    db_migrations: 'Migrations',
    disk: 'Disk space',
    storage: 'File storage',
    master_web: 'Web console',
    queue_backlog: 'Queue',
    queue_stuck: 'Stuck jobs',
    queue_approval_orphan: 'Jobs waiting for a decision',
    queue_leases_expired: 'Expired leases',
    workers_offline: 'Machines',
    workers_disk: 'Machine disks',
    workers_clock: 'Machine clocks',
    workers_outdated: 'Worker versions',
    workers_login: 'Runtime sign-ins',
    workers_sandbox: 'Sandbox profiles',
    workers_git: 'Git on machines',
    expiry: 'Key and certificate lifetimes',
    integrations: 'Integrations',
    chat_assistant: 'Chat assistant',
    version_feed: 'Version feed',
    backups: 'Backups',
    errors_burst: 'Recent errors',
    webhooks_disabled: 'Webhooks',
    cost_brake: 'Cost brake',
    config: 'Configuration',
    master_url: 'Master address',
    master_dns: 'DNS lookup',
    master_connect: 'Connection / TLS',
    master_http: 'Master answer',
    clock: 'Clock',
    service: 'Service',
    directories: 'Directories',
    node: 'Node.js',
    node_npm: 'npm package manager',
    git: 'Git tool',
    runtimes: 'Runtimes',
    sandbox: 'Sandbox readiness',
    probe: 'Probe',
    machine_admin: 'Machine administration',
  },
  findings: {
    common: {
      check_failed: { text: 'This check could not run.' },
      more: { text: '{n} more of the same kind.' },
      ok: { text: 'No problem.' },
    },
    master: {
      db_reachable: {
        ok: { text: 'Postgres answers ({ms} ms).' },
        slow: {
          text: 'Postgres answers slowly ({ms} ms).',
          fix: 'Check the database host load, its connections and its disk.',
        },
        timeout: {
          text: 'Postgres did not answer in time.',
          fix: 'Check that the database container runs and DATABASE_URL points at it.',
        },
        unreachable: {
          text: 'Postgres does not answer.',
          fix: 'Check that the database container runs and DATABASE_URL points at it.',
        },
      },
      redis_reachable: {
        ok: { text: 'Redis answers ({ms} ms).' },
        slow: {
          text: 'Redis answers slowly ({ms} ms).',
          fix: 'Check the Redis container memory and the host load.',
        },
        timeout: {
          text: 'Redis did not answer in time.',
          fix: 'Check that the Redis container runs and REDIS_URL points at it.',
        },
        unreachable: {
          text: 'Redis does not answer.',
          fix: 'Check that the Redis container runs and REDIS_URL points at it.',
        },
      },
      db_migrations: {
        ok: { text: 'All migrations applied (latest {latest}).' },
        pending: {
          text: '{n} migration(s) not applied (first {first}).',
          fix: 'Restart the master: it applies pending migrations at start; if one fails, its log names it.',
        },
        newer_database: {
          text: 'The database has {n} migration(s) this release does not know (a newer release ran here).',
          fix: 'Deploy the release that matches the database; downgrading the master is not supported.',
        },
      },
      disk: {
        ok: { text: 'Enough free disk on the master host.' },
        unknown: { text: 'Disk use is not measurable here.' },
        low: {
          text: 'Disk ({disk}) is {percent} % full.',
          fix: 'Remove old backups, logs and unused Docker images, or grow the disk.',
        },
        full: {
          text: 'Disk ({disk}) is {percent} % full — nearly full.',
          fix: 'Free space now (old backups, docker system prune) or grow the disk.',
        },
      },
      storage: {
        ok: { text: 'File storage is in order ({mode}).' },
        unknown: { text: 'File storage is not measurable here.' },
        unusable: {
          text: 'Object storage is selected but not usable.',
          fix: 'Enter the bucket settings and keys again in Settings → Integrations → Storage, or switch to local disk.',
        },
        unreachable: {
          text: 'Object storage does not answer ({error}).',
          fix: 'Run "Test connection" in Settings → Integrations → Storage; check the endpoint, the keys and the bucket policy.',
        },
        local_low: {
          text: 'The blob directory has {freeMiB} MiB free ({percent} % used).',
          fix: 'Plan more room for large outputs: grow the volume, set a retention per project, or use object storage.',
        },
        local_full: {
          text: 'The blob directory is nearly full: {freeMiB} MiB free ({percent} % used).',
          fix: 'Grow the blob volume, lower the retention of projects, or move outputs to object storage.',
        },
        legacy_bytes: {
          text: '{mib} MiB of files are still in the database.',
          fix: 'Run `remyral-master blobs:migrate` on the master: it moves them to the file storage and verifies each one.',
        },
      },
      master_web: {
        ok: { text: 'The web console answers.' },
        not_probed: { text: 'The web console is not probed (STATUS_WEB_URL unset).' },
        failing: {
          text: 'The web console does not answer ({code}).',
          fix: 'Restart the web container in Coolify and check the proxy network.',
        },
      },
      queue_backlog: {
        ok: { text: '{queued} queued, {running} running.' },
        unknown: { text: 'The queue could not be read.' },
        waiting: {
          text: '{n} job(s) queued; the oldest waits for {minutes} min.',
          fix: "Check that a machine with the job's runtime and sandbox is online and free; the job page says why it waits.",
        },
      },
      queue_stuck: {
        ok: { text: 'No job is stuck.' },
        no_lease: {
          text: 'A job is {state} for {minutes} min without a lease.',
          fix: 'Check its machine (offline?); cancel or retry the job from its page.',
        },
        lease_expired: {
          text: 'A job is {state} for {minutes} min with an expired lease.',
          fix: 'The lease sweeper should requeue it; if it stays, check its machine and cancel or retry the job.',
        },
      },
      queue_approval_orphan: {
        ok: { text: 'Every job waiting for approval has something to decide.' },
        nothing_to_decide: {
          text: 'A job waits for an approval for {minutes} min, but no approval request is open.',
          fix: 'Open the job: approve or reject its result there, or cancel it. Report it if no button helps.',
        },
      },
      queue_leases_expired: {
        ok: { text: 'No expired lease is left open.' },
        open: {
          text: '{n} expired lease(s) are still open.',
          fix: 'The lease sweeper closes them every few seconds; if the number stays, the logs (orchestrator) say why.',
        },
      },
      workers_offline: {
        ok: { text: 'All {n} machine(s) are online.' },
        none: {
          text: 'No machine is paired: jobs cannot run.',
          fix: 'Add a machine in Machines → Add machine and approve its pairing.',
        },
        offline: {
          text: '{name} is offline (last seen {minutes} min ago).',
          fix: 'Check the machine is on and online; run `remyral-worker doctor` on it (works without the master) and restart the worker service.',
        },
      },
      workers_disk: {
        ok: { text: 'Every machine has enough free disk.' },
        disk_low: {
          text: '{name} is below its minimum free disk: no job is placed there.',
          fix: 'Run Disk cleanup → Clean now on the machine page (the worker removes its own files), free space under the workspace root (kept working directories) or lower workspace.minFreeBytes.',
        },
        disk_low_after_cleanup: {
          text: '{name} is still below its minimum free disk after its own cleanup ({freedMiB} MiB freed); {largest} uses the most space ({largestMiB} MiB).',
          fix: 'The worker removed everything it may (caches, old versions, logs, expired files). The space per directory is on the machine page; free space outside the worker data, grow the disk or lower workspace.minFreeBytes.',
        },
        disk_tight: {
          text: '{name} is close to its minimum free disk.',
          fix: 'Free space under the workspace root before jobs are refused.',
        },
      },
      workers_clock: {
        ok: { text: 'Machine clocks agree with the master.' },
        skew: {
          text: 'The clock of {name} differs from the master by {seconds} s.',
          fix: 'Turn on automatic time sync (NTP): leases, signed commands and sign-ins depend on the clock.',
        },
      },
      workers_outdated: {
        ok: { text: 'Every machine runs the released worker ({stable}).' },
        no_release: { text: 'No stable worker release is published.' },
        outdated: {
          text: '{name} runs worker {version}; {stable} is released.',
          fix: 'It updates itself when the rollout reaches it; see Settings → Worker releases.',
        },
      },
      workers_login: {
        ok: { text: 'Every installed runtime is signed in.' },
        not_signed_in: {
          text: '{runtime} on {name} is installed but not signed in.',
          fix: 'Sign it in from Machines → <machine> → Runtimes or give it an API key credential.',
        },
      },
      workers_sandbox: {
        ok: { text: 'Every machine has a ready sandbox profile.' },
        none_ready: {
          text: 'No sandbox profile is ready on {name}.',
          fix: 'Run "Prepare" in Machines → <machine> → Sandbox & policy.',
        },
      },
      workers_git: {
        ok: { text: 'git is ready on every machine.' },
        git_missing: {
          text: 'git is not installed on {name}: repository jobs cannot run.',
          fix: 'Install git (on Windows Machines → <machine> → Tools: MinGit) or set gitBinary.',
        },
        git_problems: {
          text: 'git on {name} has {n} blocking problem(s) ({codes}).',
          fix: 'Open Machines → <machine> → Git and press "Fix", or follow the listed steps.',
        },
      },
      expiry: {
        ok: { text: 'No key, token or certificate expires soon.' },
        unknown: { text: 'Key and certificate lifetimes could not be read.' },
        expired: {
          text: '{what}: expired or overdue for rotation.',
          fix: 'Rotate it with its runbook (Settings → Operations safety → Keys and lifetimes) and stamp it rotated.',
        },
        urgent: {
          text: '{what}: {days} day(s) left.',
          fix: 'Rotate it with its runbook (Settings → Operations safety → Keys and lifetimes).',
        },
        soon: { text: '{what}: {days} day(s) left.', fix: 'Plan the rotation in the coming days.' },
      },
      integrations: {
        ok: { text: 'Connected integrations passed their last tests.' },
        none: { text: 'No integration is connected.' },
        coolify_failing: {
          text: 'Coolify connection "{label}" failed its last test or cannot be used.',
          fix: 'Test it again in Settings → Integrations → Coolify; replace the token if it was revoked.',
        },
        cloudflare_failing: {
          text: 'The Cloudflare token failed its last test.',
          fix: 'Test it in Settings → Integrations → Cloudflare; create a new token if it expired.',
        },
        git_host_failing: {
          text: '{kind} connection "{label}" failed its last test ({code}).',
          fix: 'Test it again in Settings → Integrations; replace the token if it was revoked or lacks a scope.',
        },
        github_failing: {
          text: 'The GitHub App key cannot be used or {missing} permission(s) are missing.',
          fix: 'Settings → Integrations → GitHub: upload the key again or accept the requested permissions on GitHub.',
        },
      },
      chat_assistant: {
        ok: { text: 'The chat answers on {machine} with a ready backup machine.' },
        unknown: { text: 'The chat routing could not be read.' },
        unavailable: {
          text: 'The chat assistant cannot answer right now.',
          fix: 'Pick a connected machine with a signed-in runtime in Settings → Chat.',
        },
        no_failover: {
          text: 'The chat runs on {machine} with no ready backup machine.',
          fix: 'Add a backup machine in Settings → Chat so the chat moves when the main one goes offline.',
        },
      },
      version_feed: {
        ok: { text: 'The version feed is current.' },
        off: { text: 'The version feed is off.' },
        failing: {
          text: '{failing} of {items} sources failed their last check.',
          fix: 'Usually temporary; if it stays, the master cannot reach the internet (proxy, DNS).',
        },
      },
      backups: {
        ok: { text: 'Backups are current.' },
        not_configured: {
          text: 'Backups are not configured.',
          fix: 'Set up the backup service (docs/ops/backup-restore.md); without it a lost disk loses everything.',
        },
      },
      errors_burst: {
        ok: { text: 'No error burst in the last hour.' },
        http_5xx: {
          text: '{n} server error(s) (HTTP 5xx) in the last {minutes} min.',
          fix: 'Search the logs for level error in Settings → System status → Logs.',
        },
        log_errors: {
          text: '{n} error lines in the master log in the last hour (most: {top}).',
          fix: 'Filter Settings → System status → Logs by level error and this component.',
        },
      },
      webhooks_disabled: {
        ok: { text: 'No webhook was turned off.' },
        auto_disabled: {
          text: 'Webhook "{name}" was turned off after repeated failures.',
          fix: 'Fix the receiver, then resume it in Settings → Webhooks (the delivery log shows the errors).',
        },
      },
      cost_brake: {
        ok: { text: 'The cost brake is not engaged.' },
        unknown: { text: 'The cost brake could not be read.' },
        engaged: {
          text: 'Model spend of {scope} reached {percent} % of its {window} ceiling.',
          fix: 'An owner lifts it for some hours in Settings → Operations safety → Cost brake, or raises the ceiling.',
        },
        blocking: {
          text: 'Model spend of {scope} reached its {window} ceiling: new non-urgent jobs wait.',
          fix: 'An owner lifts it in Settings → Operations safety → Cost brake, or raises the ceiling.',
        },
      },
    },
    worker: {
      config: {
        ok: { text: 'The config file is valid ({path}).' },
        invalid: {
          text: 'The worker config cannot be used ({path}).',
          fix: 'Fix the file; `remyral-worker service status` shows which one is read.',
        },
      },
      master_url: { invalid: { text: 'masterUrl is not a ws:// or wss:// URL.' } },
      master_dns: {
        ok: { text: '{host} resolves.' },
        dns_failed: {
          text: '{host} does not resolve ({code}).',
          fix: "Check the machine's DNS / internet connection and the master host name in the config.",
        },
      },
      master_connect: {
        ok: { text: 'The connection and TLS to the master are fine.' },
        unreachable: {
          text: '{host}:{port} cannot be reached ({code}).',
          fix: 'Check the firewall / proxy between this machine and the master (outbound HTTPS 443) and that the master is up.',
        },
        tls_failed: {
          text: 'This machine does not trust the certificate of {host} ({code}).',
          fix: "Check the machine's date and CA store; a corporate proxy that intercepts TLS needs its CA trusted.",
        },
        plain: {
          text: '{host} is reached without TLS (ws://).',
          fix: 'Use wss:// for every master that is not on this machine.',
        },
        cert_expiring: {
          text: 'The master certificate expires in {days} day(s).',
          fix: 'Renew the certificate (Coolify / the proxy renews Let’s Encrypt automatically — check it).',
        },
      },
      master_http: {
        ok: { text: 'The master answers its status probe.' },
        master_unavailable: {
          text: 'The master is up but not ready (its database or Redis is down).',
          fix: 'The owner checks Settings → System status or the containers in Coolify.',
        },
        http_failed: {
          text: 'The master status probe failed.',
          fix: 'A proxy in between may block requests; the worker needs plain outbound HTTPS and WebSocket to the master.',
        },
        http_unexpected: {
          text: 'The master status probe answered HTTP {status}.',
          fix: 'A proxy in between may block or rewrite requests.',
        },
      },
      clock: {
        ok: { text: 'The clock agrees with the master ({seconds} s).' },
        skew: {
          text: "This machine's clock differs from the master by {seconds} s.",
          fix: 'Turn on automatic time sync (NTP / Windows Time).',
        },
        not_checked: { text: 'The clock could not be compared (the master did not answer).' },
      },
      service: {
        ok: { text: 'The worker service runs ({state}).' },
        unknown: { text: 'The service manager could not be queried.' },
        not_installed: {
          text: 'The worker is not installed as a service.',
          fix: 'Install the service with the installer from Machines → Add machine: it starts at boot and can be restarted remotely.',
        },
        not_running: {
          text: 'The worker service does not run ({state}).',
          fix: 'Start it and read boot.log / worker.log in the data directory.',
        },
        stale: {
          text: 'The service runs but its status file is stale (it may hang).',
          fix: 'Restart the worker service.',
        },
      },
      directories: {
        ok: { text: 'The data directory and the workspace root are usable.' },
        missing: {
          text: '{dir} does not exist ({path}).',
          fix: 'Create it and give the worker account write access (the installer does this).',
        },
        not_writable: {
          text: '{dir} is not writable ({path}).',
          fix: 'Give the worker account write access.',
        },
        world_writable: {
          text: '{dir} is writable by everyone ({path}).',
          fix: 'Remove write access for other users (chmod o-w / icacls): the worker refuses to run otherwise.',
        },
      },
      disk: {
        ok: { text: 'Enough free disk.' },
        low: {
          text: '{dir}: little free disk.',
          fix: 'Free space (kept working directories, old runtime versions, Docker images) or move the directory to a larger disk.',
        },
        last_cleanup: {
          text: 'The worker’s own cleanup last ran at {at} and freed {freedMiB} MiB.',
          fix: 'It runs by itself when the disk gets low and once a day; the machine page has “Clean now” and shows what uses the space.',
        },
      },
      node: {
        ok: { text: 'Node {version}.' },
        too_old: {
          text: 'Node {version} is older than {required}.',
          fix: 'Install Node {required} (the installer bundles it).',
        },
      },
      node_npm: {
        ok: { text: 'npm {version}.' },
        missing: {
          text: 'npm is not found next to Node: runtime versions outside the release pin cannot be installed here.',
        },
      },
      git: {
        ok: { text: 'git {version}.' },
        missing: {
          text: 'git is not installed: repository jobs cannot run here.',
          fix: 'Install git (on Windows the console installs MinGit) or set gitBinary in the config.',
        },
      },
      runtimes: {
        ok: { text: '{runtime} {version} (installed).' },
        probe_failed: { text: 'The runtime / tool probe did not finish.' },
        not_installed: {
          text: '{runtime} is allowed but not installed.',
          fix: 'Install it from Machines → <machine> → Runtimes.',
        },
        not_signed_in: {
          text: '{runtime} is installed but not signed in.',
          fix: 'Sign it in from the console or give it an API key credential.',
        },
        pin_mismatch: { text: '{runtime} {version} differs from the release pin {pin}.' },
      },
      sandbox: {
        ok: { text: 'A sandbox profile is ready.' },
        none_ready: {
          text: 'No sandbox profile is ready on this machine.',
          fix: 'Run "Prepare" in Machines → <machine> → Sandbox & policy.',
        },
      },
      machine_admin: {
        ok: { text: 'The privileged helper can start machine administration sessions.' },
        install_dir_unknown: {
          text: 'Machine administration is unavailable: the worker does not know its install folder.',
        },
        helper_missing: {
          text: 'Machine administration is unavailable: no privileged helper is installed.',
          fix: 'If machine administration is needed, run the installer kit of this release once as admin / root.',
        },
        helper_outdated: {
          text: 'Machine administration is unavailable: the installed privileged helper is too old.',
          fix: 'Re-run the installer kit of this release once as admin / root.',
        },
        admin_unit_missing: {
          text: 'Machine administration is unavailable: the systemd trigger (remyral-worker-admin.path) is not installed.',
          fix: 'Re-run the installer kit once as root.',
        },
        admin_unit_disabled: {
          text: 'Machine administration is unavailable: the systemd trigger (remyral-worker-admin.path) is not enabled.',
          fix: 'Re-run the installer kit once as root.',
        },
        state_dir_not_traversable: {
          text: 'Machine administration is unavailable: the worker account cannot reach the helper’s answer folder (state/machine-admin).',
          fix: 'Re-run the installer kit of this release once as root.',
        },
        admin_task_missing: {
          text: 'Machine administration may be unavailable: the scheduled task (RemyralWorkerAdmin) was not found.',
          fix: 'Re-run the installer kit once as Administrator.',
        },
        admin_task_unreadable: {
          text: 'The scheduled task of machine administration (RemyralWorkerAdmin) could not be queried.',
        },
        admin_plist_missing: {
          text: 'Machine administration is unavailable: the LaunchDaemon (com.remyral.worker.admin) is not installed.',
          fix: 'Re-run the installer kit once as admin.',
        },
        probe_failed: { text: 'The machine administration readiness check did not finish.' },
      },
    },
  },
  machines: {
    title: 'Machine doctors',
    sub: 'Every machine checks its own side: connection to the master, clock, service, disk, runtimes, sandbox. On a machine that cannot reach the master, run `remyral-worker doctor`.',
    none: 'No machine result yet. Run diagnostics with "Also check the machines", or ask one machine for its doctor.',
    request: 'Run its doctor',
    states: {
      done: 'Done',
      pending: 'Waiting for the answer',
      failed: 'Failed',
      unsupported: 'Not supported',
      offline: 'Offline',
    },
    older: 'Older worker build: basic diagnostics only.',
    reportOf: (p: { version: string; platform: string }) => `worker ${p.version} on ${p.platform}`,
    cli: (p: { command: string }) => `On the machine: ${p.command}`,
  },
  report: {
    title: 'Support report',
    sub: 'One redacted zip: doctor results, system status, versions, allowlisted settings, recent warning / error log lines, a summary of failed jobs, machine doctors. You see its contents before you send it.',
    description: 'Open a support request — describe the problem',
    descriptionHint: 'What happened, since when, what did you try? Do not write passwords or tokens.',
    sections: 'Sections',
    sectionNames: {
      doctor: 'Doctor results',
      workers: 'Machine doctors',
      status: 'System status',
      versions: 'Versions',
      config: 'Settings (allowlisted keys)',
      logs: 'Warning and error log lines',
      failed_jobs: 'Failed jobs (summary only)',
      job_prompts: 'Job prompts and titles',
    },
    jobPromptsWarning: 'Job prompts may contain customer data; include them only when really needed.',
    hours: 'Log window',
    hoursValue: (p: { n: number }) => `Last ${String(p.n)} hours`,
    preview: 'Preview',
    rebuild: 'Refresh the preview',
    files: 'Files',
    file: 'File',
    section: 'Section',
    size: 'Size',
    items: 'Records',
    total: (p: { size: string; files: number }) => `${String(p.files)} files · ${p.size}`,
    summary: 'Summary (report.md)',
    overCap: (p: { max: string }) =>
      `The report is larger than ${p.max}: it is not attached, only the summary is sent. Download the zip to share it another way.`,
    download: 'Download the zip',
    expires: (p: { at: string }) => `This report is kept until ${p.at}.`,
    sendTitle: 'Send the report by e-mail',
    recipient: (p: { to: string }) => `Recipient: ${p.to}`,
    recipientMissing:
      'No support address is set: enter one in the support settings below to send the report by e-mail, or download the zip.',
    ccMe: (p: { address: string }) => `Send me a copy (${p.address})`,
    ccMissing: 'Add your e-mail address in Settings → Notifications to get a copy.',
    send: 'Send the report by e-mail',
    sendStepUp: 'Send the diagnostics report to the support address',
    smtpMissing:
      'No e-mail server is configured: enter the SMTP server in the support settings below, or download the zip.',
    sent: (p: { to: string; at: string }) => `Sent to ${p.to} (${p.at}).`,
    sentSummaryOnly: 'The zip was too large, so only the summary was sent.',
    noSections: 'Choose at least one section.',
  },
  settings: {
    title: 'Support settings',
    sub: 'Where the report goes and the e-mail server that sends it. The password is stored encrypted and never shown.',
    email: 'Support address',
    defaultEmail: (p: { email: string }) => `Default: ${p.email}`,
    noDefaultEmail: 'Not set by default. Leave it empty to only download reports; nothing is e-mailed then.',
    source: {
      settings: 'Sender: the SMTP server set here.',
      notifications:
        "Sender: the master's notification SMTP (NOTIFY_SMTP_*). You may set a separate server here.",
      none: 'No e-mail server: enter an SMTP server below.',
    },
    smtpTitle: 'SMTP server (optional)',
    host: 'Host',
    port: 'Port number',
    security: 'Security',
    securityStarttls: 'STARTTLS (587)',
    securityTls: 'TLS (465)',
    from: 'Sender address',
    username: 'User name',
    password: 'Password',
    passwordSet: 'Stored (type to change)',
    removeSmtp: 'Remove the SMTP server',
    save: 'Save',
    saveStepUp: 'Change the support settings',
    saved: 'Support settings saved.',
    ownerOnly: 'Only the owner can change these settings.',
    updated: (p: { at: string; by: string }) => `Last changed ${p.at} · ${p.by}`,
  },
  card: {
    label: 'Support report',
    kind: 'Support report',
    recipient: 'Recipient',
    sections: 'Sections',
    hours: 'Log window',
    ccMe: 'Copy to me',
    yes: 'yes',
    no: 'no',
    description: 'Description',
    promptsWarning: 'Job prompts will be sent too.',
    note: 'On confirmation the redacted report is built and e-mailed. You can preview and download it first in Settings → Diagnostics.',
  },
} satisfies Shape<typeof tr>;
