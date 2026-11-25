import type { ReasonVars } from '../reason-vars.js';
import type { Shape } from '../shape.js';
import type tr from '../tr/reasons.js';

/**
 * p14-i18n-reasons (i18n Phase 4; was the sentence table of apps/web/src/lib/reasons.ts): the reason codes in
 * English — the classic console's wording, word for word.
 */

const rt = (v: ReasonVars): string => v.runtime ?? 'The runtime';
const thisRuntime = (v: ReasonVars): string => v.runtime ?? 'this runtime';
const rtName = (v: ReasonVars): string => v.runtime ?? 'runtime';
const machine = (v: ReasonVars): string => v.machine ?? 'this machine';
const Machine = (v: ReasonVars): string => v.machine ?? 'This machine';

const unproven = (v: ReasonVars): string =>
  `${rt(v)} is not proven on ${machine(v)} yet. Prove it with Machine → Runtimes → Verify, or allow it once in Runtime policy.`;
const notInstalled = (v: ReasonVars): string => `${rt(v)} is not installed on ${machine(v)}.`;
const signedOut = (v: ReasonVars): string => `${rt(v)} is signed out on ${machine(v)}.`;
const notPinned = (v: ReasonVars): string => `${rt(v)} on ${machine(v)} is not the pinned version.`;
const notAllowed = (v: ReasonVars): string =>
  `The runtime policy of ${machine(v)} does not allow ${thisRuntime(v)}.`;
const tooOld = (v: ReasonVars, what: string): string =>
  `${Machine(v)} runs a worker too old ${what}. Update it.`;
const sharedLoginRace = (v: ReasonVars): string =>
  `Two ${rtName(v)} runs on ${machine(v)} refreshed the shared subscription login at the same time, so it is probably no longer valid. Log in again; subscription jobs there now run one at a time.`;
const doesNotTakeProject = (v: ReasonVars): string => `${Machine(v)} does not take work for this project.`;
const offline = (v: ReasonVars): string => `${Machine(v)} is offline.`;

export default {
  codes: {
    capability_unverified: (v: ReasonVars) => unproven(v),
    unverified: (v: ReasonVars) => unproven(v),
    runtime_not_installed: (v: ReasonVars) => notInstalled(v),
    not_installed: (v: ReasonVars) => notInstalled(v),
    runtime_not_authenticated: {
      default: (v: ReasonVars) => signedOut(v),
      login_wait: (v: ReasonVars) =>
        `${rt(v)} needs a login on ${machine(v)} — the job waits and starts by itself once you log in again.`,
    },
    not_authenticated: {
      default: (v: ReasonVars) => signedOut(v),
      no_job_auth: (v: ReasonVars) =>
        `No sign-in method is chosen for ${thisRuntime(v)} jobs on ${machine(v)}, so jobs do not use its subscription login.`,
      job_auth_secret_ref: (v: ReasonVars) =>
        `${rt(v)} jobs on ${machine(v)} use an API key that is not available there, not its subscription login.`,
    },
    login_expired: {
      default: (v: ReasonVars) => `The ${rtName(v)} login on ${machine(v)} has expired.`,
      shared_refresh_race: (v: ReasonVars) => sharedLoginRace(v),
    },
    login_refresh_contention: {
      default: (v: ReasonVars) => sharedLoginRace(v),
      run_again: (v: ReasonVars) =>
        `Another ${rtName(v)} process on ${machine(v)} was refreshing the same login at that moment, so this run could not start. The login is fine — run the job again.`,
    },
    runtime_version_unverified: (v: ReasonVars) => notPinned(v),
    pin_mismatch: (v: ReasonVars) => notPinned(v),
    runtime_version_mismatch: (v: ReasonVars) =>
      `${rt(v)} on ${machine(v)} is a version this job cannot use.`,
    runtime_not_allowed_by_policy: (v: ReasonVars) => notAllowed(v),
    not_allowed: (v: ReasonVars) => notAllowed(v),
    runtime_not_enabled: (v: ReasonVars) => `${v.runtime ?? 'This runtime'} is not enabled on ${machine(v)}.`,
    no_ready_runtime: (v: ReasonVars) => `${Machine(v)} has no runtime that is ready to run work.`,
    degraded: (v: ReasonVars) =>
      `${rt(v)} runs on ${machine(v)} with features not yet proven here (allowed in Runtime policy). To prove them: Machine → Runtimes → Verify.`,
    unsupported: (v: ReasonVars) =>
      `${rt(v)} cannot run on ${machine(v)}: a required feature is unsupported.`,
    capabilities_unknown: (v: ReasonVars) => `${Machine(v)} has not reported what it can run yet.`,
    runtime_removed: (_v: ReasonVars) =>
      'OpenHands was removed from the platform (ADR-0023). Choose Claude Code, Codex, Pi or OpenCode.',
    model_profile_unavailable: (_v: ReasonVars) =>
      'The chosen model profile is disabled, deleted or not valid for this runtime.',
    model_profile_not_allowed: (_v: ReasonVars) =>
      'The runtime policy does not allow the chosen model profile.',
    credential_missing: (v: ReasonVars) => `The runtime’s credential has not reached ${machine(v)}.`,
    secret_bound_to_other_worker: (_v: ReasonVars) => 'The job’s secret is sealed to another machine.',
    tool_missing: (v: ReasonVars) => `A tool the job needs (such as git) is missing on ${machine(v)}.`,
    sandbox_profile_unavailable: (v: ReasonVars) =>
      `The sandbox the job needs is not ready on ${machine(v)}.`,
    unconfined_not_enabled: (v: ReasonVars) => `Full machine access is turned off on ${machine(v)}.`,
    unconfined_not_opted_in: (_v: ReasonVars) => 'This project does not allow full machine access.',
    host_execution_not_enabled: (_v: ReasonVars) =>
      'This project does not allow running directly on the machine.',
    auto_approve_not_allowed: (_v: ReasonVars) =>
      'This project does not allow jobs that never ask for approval.',
    approval_policy_unsupported: (v: ReasonVars) => tooOld(v, 'for jobs that never ask'),
    workspace_unsupported: (v: ReasonVars) => tooOld(v, 'for work-area projects'),
    pr_head_unsupported: (v: ReasonVars) => tooOld(v, 'to check out pull requests from forks'),
    site_bundle_unsupported: (v: ReasonVars) => tooOld(v, 'to build site bundles for Pages deploys'),
    /** p16-zip-job-input: the job pulls the files of a .zip into in/ (input-bundle-v1). */
    input_bundle_unsupported: (v: ReasonVars) => tooOld(v, "to receive a job's input files from a .zip"),
    /** p19-repo-job-inputs: a repository job with input files (repo-inputs-v1). */
    repo_inputs_unsupported: (v: ReasonVars) => tooOld(v, 'to give a repository job input files'),
    skill_layout_unsupported: (v: ReasonVars) =>
      tooOld(v, "for the job's larger skills (wider skill layout)"),
    mcp_unsupported: (v: ReasonVars) => tooOld(v, 'for jobs with external MCP servers'),
    function_unsupported: (v: ReasonVars) => tooOld(v, 'to run workflow HTTP, e-mail or code nodes'),
    mcp_not_installed: (v: ReasonVars) =>
      `This job's local MCP package is not installed on ${machine(v)}. Skills → MCP servers → Install.`,
    integration_unsupported: (v: ReasonVars) => tooOld(v, 'to merge branches for an integration'),
    machine_admin_unsupported: (v: ReasonVars) => tooOld(v, 'for machine admin tasks'),
    machine_admin_not_enabled: (v: ReasonVars) => `Machine admin tasks are turned off on ${machine(v)}.`,
    project_not_assigned: (v: ReasonVars) => `${Machine(v)} is not assigned to this project.`,
    project_not_allowed: (v: ReasonVars) => doesNotTakeProject(v),
    project_not_in_worker_allowlist: (v: ReasonVars) => doesNotTakeProject(v),
    repo_not_registered: (_v: ReasonVars) => 'The project’s repository is not registered.',
    config_not_applied: (v: ReasonVars) => `${Machine(v)} has not applied its configuration yet.`,
    blocked_by_local_ceiling: (v: ReasonVars) =>
      `The local settings file on ${machine(v)} blocks it. Change it on the machine.`,
    worker_not_selected: (_v: ReasonVars) => 'The job is pinned to other machines.',
    os_mismatch: (_v: ReasonVars) => 'The job needs a different operating system.',
    arch_mismatch: (_v: ReasonVars) => 'The job needs a different processor architecture.',
    declined_before: (v: ReasonVars) => `${Machine(v)} declined this job before.`,
    no_free_slot: (v: ReasonVars) => `${Machine(v)} is busy: every job slot is taken.`,
    disk_low: (v: ReasonVars) =>
      `${Machine(v)} has less free disk than its minimum free disk setting; the job starts once space is freed or on another machine.`,
    no_free_function_slot: (v: ReasonVars) =>
      `${Machine(v)} is busy: every slot for workflow nodes is taken. The job waits.`,
    no_free_profile_slot: (v: ReasonVars) =>
      `${Machine(v)} is busy for this sandbox profile: its slots for it are taken. The job waits.`,
    urgent_slot_reserved: (v: ReasonVars) =>
      `${Machine(v)} keeps its last free slot for urgent (Acil) jobs. The job waits for another slot ` +
      '(a sub-job of a job running there may use it; an admin can change the reserve on the machine page).',
    declined_busy: (v: ReasonVars) =>
      `${Machine(v)} was busy and asked to wait; the job runs there when a slot frees up.`,
    subscription_login_exclusive: (v: ReasonVars) =>
      `Subscription logins (Claude Code / Codex) run as the machine's own account on ${machine(v)}, so they never run beside another job's work (only beside their own parent or sub-jobs); API-key jobs run in parallel. The job waits.`,
    subscription_login_busy: (v: ReasonVars) =>
      `Another job is using the same subscription login on ${machine(v)} right now; one job at a time uses one login (Claude Code and Codex logins are separate). The job waits.`,
    not_enrolled: (v: ReasonVars) => `${Machine(v)} is waiting to be paired.`,
    quarantined: (v: ReasonVars) => `${Machine(v)} is quarantined.`,
    offline: (v: ReasonVars) => offline(v),
    worker_offline: (v: ReasonVars) => offline(v),
    updating: (v: ReasonVars) => `${Machine(v)} is updating and takes no new work for now.`,
    draining: (v: ReasonVars) => `${Machine(v)} is finishing its jobs and takes no new ones.`,
    no_workers: (_v: ReasonVars) => 'No machine can run this job.',
    provider_paused: (_v: ReasonVars) =>
      'The runtime reached its usage limit on this machine (subscription or provider quota); work starts again when it resets.',
    account_concurrency: (_v: ReasonVars) => 'The account is already running as many jobs as it may.',
    budget_exceeded: (_v: ReasonVars) => 'The budget for this work is used up.',
    deferred_off_peak: (_v: ReasonVars) => 'The job waits for its project’s off-peak window.',
    provider_usage_limit: (_v: ReasonVars) =>
      'The runtime hit its provider’s usage limit. The job waits for the reset or continues on a fallback, as the project’s usage-limit policy says.',
    usage_limited: (_v: ReasonVars) =>
      'This runtime’s credential or model is at its usage limit until it resets; another runtime of the job may run instead.',
    paid_fallback_not_allowed: (v: ReasonVars) =>
      `The fallback runtime would run with an API key on ${machine(v)} (billed per token); the project does not allow paid fallbacks.`,
    account_limited: (v: ReasonVars) =>
      `Every account of this runtime on ${machine(v)} is at its usage limit; the job waits for the first reset or continues on another account / fallback.`,
    runtime_crashed: {
      default: (v: ReasonVars) =>
        `${rt(v)} stopped unexpectedly on ${machine(v)}. The job's details show its exit and last error lines; it is retried automatically when the security policy allows.`,
      out_of_memory: (v: ReasonVars) =>
        `${rt(v)} ran out of memory on ${machine(v)} and stopped. Reduce the other work there or run the job on a machine with more memory; it is retried automatically (on another machine first).`,
      killed: (v: ReasonVars) =>
        `${rt(v)} was killed by the system on ${machine(v)} (a signal such as SIGKILL — often memory pressure, a restart or a manual stop). The job is retried automatically.`,
      provider_overloaded: (v: ReasonVars) =>
        `The ${rtName(v)} API was overloaded or answered with a server error (5xx). This is temporary; the job is retried automatically.`,
      network: (v: ReasonVars) =>
        `${rt(v)} could not reach its API from ${machine(v)} (network or DNS error). Check the machine's internet connection; the job is retried automatically.`,
      login: (v: ReasonVars) =>
        `${rt(v)} stopped because its login on ${machine(v)} is not usable. Log in again.`,
      usage_limit: (v: ReasonVars) =>
        `${rt(v)} hit its provider's usage limit. The job waits for the reset or continues on a fallback.`,
    },
    http_error: {
      default: (_v: ReasonVars) => 'The HTTP request failed (connection, TLS or protocol error).',
      tls_untrusted: (_v: ReasonVars) =>
        'The server’s certificate is not trusted (self-signed or from an unknown issuer). If it is your own internal service, trust this certificate for the project; verification stays on for every other address.',
    },
    dns_failed: {
      default: (_v: ReasonVars) =>
        'The domain does not resolve: DNS has no address for it. Check its DNS records (in Cloudflare: does the record exist, is the zone active?).',
      tunnel_address: (_v: ReasonVars) =>
        'The address is a Cloudflare quick-tunnel address that no longer resolves; the tunnel (preview) behind it was probably stopped. Start the preview again and use its new address.',
      preview_stopped: (_v: ReasonVars) =>
        'The address belongs to a preview / service tunnel that is stopped, so it does not resolve any more. Start the preview again.',
    },
    account_unavailable: (v: ReasonVars) =>
      `No account of this runtime on ${machine(v)} can take the job now (paused, signed out, an API key without the paid switch, or pinned elsewhere).`,
  },
  actions: {
    allow: 'Allow',
    installRuntime: 'Install runtime',
    logInAgain: 'Log in again',
    installPinned: 'Install pinned version',
    changeVersion: 'Change version',
    openRuntimePolicy: 'Open runtime policy',
    enableRuntime: 'Enable runtime',
    setUpRuntime: 'Set up a runtime',
    openMachine: 'Open machine',
    openModels: 'Open models',
    openCredentials: 'Open credentials',
    installTools: 'Install tools',
    prepareSandbox: 'Prepare sandbox',
    openSandbox: 'Open sandbox',
    openProjectPolicy: 'Open project policy',
    updateMachine: 'Update machine',
    openMachineAdmin: 'Open machine admin',
    assignMachine: 'Assign machine',
    registerRepository: 'Register repository',
    openConfiguration: 'Open configuration',
    pairMachine: 'Pair machine',
    openMachines: 'Open machines',
    openMcpServers: 'Open MCP servers',
    openUsage: 'Open usage',
    openBudgets: 'Open budgets',
    openDiskSetting: 'Open the minimum free disk setting',
  },
} satisfies Shape<typeof tr>;
