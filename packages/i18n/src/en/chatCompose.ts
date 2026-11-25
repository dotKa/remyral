import { plural } from '../plural.js';
import type { Shape } from '../shape.js';
import type tr from '../tr/chatCompose.js';

const jobs = (n: number): string => `${String(n)} ${plural('en', n, { one: 'job', other: 'jobs' })}`;

/** p14-i18n-screens-a (i18n Phase 5): Sohbet's job drafting (draft card, choices, limit line, queue, slash commands). */
export default {
  priorityClass: {
    urgent: 'Urgent',
    normal: 'Standard',
    background: 'Background',
  },
  classHint: {
    urgent: 'Starts first; may use the slot kept for urgent jobs.',
    normal: 'Starts in turn.',
    background: 'Runs only on spare capacity.',
  },
  sandbox: {
    container: {
      label: 'Container',
      text: 'An isolated container that sees only the job’s files. The safest choice.',
    },
    'runtime-sandbox': {
      label: 'The runtime’s own sandbox',
      text: 'On the machine, inside the runtime’s own sandbox.',
    },
    'host-restricted': {
      label: 'On the machine, restricted',
      text: 'On the machine, as a restricted user that can reach only the job’s folder.',
    },
    unconfined: {
      label: 'Whole machine',
      text: 'No file or network limits, with the machine’s service account.',
    },
  },
  approval: {
    'ask-sensitive': {
      label: 'Ask on sensitive steps',
      text: 'Steps such as push, network and delete come to you. Recommended.',
    },
    'ask-all': { label: 'Ask on every step', text: 'Every step the runtime reports waits for you.' },
    'deny-sensitive': {
      label: 'Deny sensitive steps',
      text: 'Denies without asking; for unattended jobs.',
    },
    'allow-all': {
      label: 'Never ask (full access)',
      text: 'Every tool call runs without asking; protected merges, deploys and the vault still need approval.',
    },
  },
  verify: {
    off: 'No verification',
    report: 'Verify when done and report',
    gate: 'Verify when done; deploys wait for it',
  },
  limit: {
    window: {
      '5h': '5-hour',
      weekly: 'weekly',
      'Opus weekly': 'Opus weekly',
      'Sonnet weekly': 'Sonnet weekly',
    },
    percent: (p) => p.value,
    limited: 'at its limit; jobs held by the threshold wait',
    limitedUntil: (p) => `at its limit, resets at ${p.time}; jobs held by the threshold wait`,
    resets: (p) => `, resets at ${p.time}`,
    multiAccount: (p) =>
      `emptiest: ${p.account} — ${p.parts} (${String(p.n)} ${plural('en', p.n, { one: 'account', other: 'accounts' })})`,
  },
  queue: {
    wait: {
      subscription_login: 'subscription sign-in',
      slot: 'waiting for a slot',
      profile_slot: 'profile slot',
      budget: 'budget',
      off_peak: 'off-peak hours',
      dependency: 'dependency',
      quota: 'usage limit',
      approval: 'approval',
      machine: 'waiting for a machine',
      other: 'waiting',
    },
    queued: 'queued',
    startNow: 'starts at once if a slot is free',
    startFirstFree: 'starts in the first free slot',
    startAfter: (p) => `after ≈ ${p.time}`,
    startAfterJobs: (p) => `after ${jobs(p.n)} finish`,
    first: 'first in line',
    afterPosition: (p) => `after #${String(p.n)}`,
  },
  slash: {
    job: {
      hint: 'turn the job you describe into an editable draft card',
      needs: 'write what should be done',
      intent:
        'Request: prepare this as an editable job draft card (draft_job); tell me your runtime advice and the limit status.',
    },
    publish: {
      hint: 'a draft card to publish a result or a site',
      needs: 'write what to publish and where',
      intent:
        'Request: prepare a deploy draft for this (draft_deploy, or draft_job.deployOnSuccess for a new job); tell me the policy result.',
    },
    approvals: {
      hint: 'summarise pending approvals by importance',
      intent: 'Request: list my pending approvals (list_approvals) and order them by importance.',
    },
    limits: {
      hint: 'runtime limit windows and reset times',
      intent: 'Request: show my runtime limits (runtime_limits): how full each window is and when it resets.',
    },
    machine: {
      hint: 'open a machine’s slots, jobs and limits',
      needs: 'pick the machine with @',
      intent: (p) =>
        `Request: describe this machine (${p.tool}): free slots, running and waiting jobs, limits.`,
    },
    cancel: {
      hint: 'an action card to cancel a job',
      needs: 'pick the job with @ or describe it',
      intent:
        'Request: prepare a job action card to cancel this job (find_jobs, then draft_job_action cancel).',
    },
    rerun: {
      hint: 'a card to run a job again with the same settings',
      needs: 'pick the job with @ or describe it',
      intent:
        'Request: prepare a job action card to run this job again (find_jobs, then draft_job_action run_again).',
    },
    missing: (p) => `For ${p.name}, ${p.needs}.`,
    template: (p) =>
      `Request: prepare a job draft from the template «${p.title}» (draft_from_template, templateId ${p.id}); ask me for any missing parameters.`,
  },
  card: {
    state: {
      proposed: 'not queued yet',
      confirmed: 'Queued',
      dismissed: 'Dismissed',
      expired: 'Expired',
    },
    titleEmpty: 'The title cannot be empty.',
    titleTooLong: 'A title has at most 60 characters; put the details in the description.',
    promptEmpty: 'Write what the agent should do.',
    fixMarked: 'Fix the marked field before queueing.',
    noMachine: 'No machine can run it with these settings.',
    kindDone: 'Job card',
    kindDraft: 'Draft job card',
    openJob: 'Open job',
    saving: 'saving…',
    enqueue: 'Queue it',
    dismiss: 'Dismiss',
    editInForm: 'Edit in the form',
    saveAsTemplate: 'Save as template',
    hintBackground: 'Once queued it starts on spare capacity; steps that need approval still come to you.',
    hintNow: 'Once queued it starts without asking you; steps that need approval still come to you.',
    submitCode: 'Send code and queue',
    adviceLabel: 'Runtime advice: ',
    switchTo: (p) => `Switch to ${p.runtime}`,
    identical: (p) => `The same job finished successfully ${p.age}. `,
    openResult: 'Open the result',
    orEnqueueAnyway: ' or queue it anyway.',
    title: 'Title',
    project: 'Project',
    cls: 'Class',
    clsGroup: 'Queue class',
    runtimeAndMachine: 'Runtime and machine',
    tagRecommended: 'recommended',
    tagLimited: 'at limit',
    tagNear: 'near limit',
    noWindow: 'No limit window reported.',
    placementWarning: (p) => `${p.warning} Change the runtime or the isolation.`,
    canRunOn: 'Machines that can run it: ',
    prompt: 'Prompt and acceptance criteria',
    queueTitle: 'Where it enters the queue',
    estimate: 'estimate',
    queueLoading: 'Reading the queue…',
    queueList: 'Queue estimate',
    moreAhead: (p) => `${jobs(p.n)} more ahead`,
    estimatedStart: (p) => `Estimated start: ${p.start}.`,
    freeSlots: (p) =>
      ` ${String(p.n)} free ${plural('en', p.n, { one: 'slot', other: 'slots' })} in the pool.`,
    settings: 'Settings',
    publishWhenDone: ' · deploy when done',
    approvalMode: 'Approval mode',
    isolation: 'Isolation',
    projectDefaultNote: ' Project default.',
    machine: 'Machine',
    machineAuto: 'Automatic (placement chooses)',
    deployTitle: 'Deploy when done',
    deployEnv: 'Deploy environment',
    envPreview: 'Preview',
    envProduction: 'Production',
    removeDeploy: 'Remove deploy',
    productionCode: 'A production deploy asks for a fresh authenticator code when you approve it.',
    verify: 'Verification',
    projectDefault: 'Project default',
    paths: 'Paths and inputs',
    mainBranch: 'main branch',
    earlierFiles: 'Files of earlier jobs are passed in as inputs.',
    /** p19-repo-job-inputs: where a repository job finds its input files. */
    repoInputsNote:
      'A repository job reads these from a scratch in/ folder next to the checkout; they are never committed.',
    removeInputs: 'Remove input files',
    fromTemplate: 'This card was prepared from a template.',
    details: 'Details',
    expiresIn: 'Draft expires in',
  },
} satisfies Shape<typeof tr>;
