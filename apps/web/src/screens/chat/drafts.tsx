import { isPriorityClass, PRIORITY_CLASS_LABEL, type PriorityClass } from '../../api/queue';
import { type ChatDraft } from '../../api/chat';
import type { ComposerPrefill } from '../composer/prefill';
import { decisionText, kindText } from '../../api/deploy';
import { formatBytes } from './attachment-files';
import { scopeLabel, TYPE_LABEL, RECORD_TYPES } from '../../api/memoryRecords';
import { actionJobs, jobActionEffect, jobActionLabel } from './JobActionParts';
import { workflowDraftOf } from './workflowDraft';

export function text(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null || v === undefined) return '—';
  return JSON.stringify(v);
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

interface FieldRow {
  readonly label: string;
  readonly value: string;
}

interface Summary {
  /** Shown on the card. */
  readonly key: readonly FieldRow[];
  /** Behind "Details". */
  readonly details: readonly FieldRow[];
  /** A job spec (Full access badge, "Edit in composer"). */
  readonly spec?: Record<string, unknown>;
  readonly prefill?: ComposerPrefill;
  /** p5-machine-admin: root / Administrator on a machine (badge + what confirming means). */
  readonly machineAdmin?: { readonly note: string; readonly fullAccess: boolean };
  /** A plain-text note shown under the title. */
  readonly notice?: { readonly testId: string; readonly text: string };
  /** p6-automation-defaults: checks the master ran on the draft (unattended approvals, placement). */
  readonly warnings?: readonly {
    readonly testId: string;
    readonly text: string;
    readonly danger?: boolean;
  }[];
  /** p5-machine-admin: a skill draft's unified diff (always visible: confirming signs it). */
  readonly diff?: string;
  /** p6-deploy-integrations: the change the master computed for an ops action (DNS before → after, resources). */
  readonly opsDiff?: Record<string, unknown>;
  /** p6-result-reuse: an identical job succeeded recently (the master's check when the draft was made). */
  readonly identical?: { readonly jobId: string; readonly age: string };
  /** p11-runtime-advice: the project's runtime advice for this work (advice only; the card keeps its runtime). */
  readonly advice?: { readonly text: string; readonly differs: boolean };
}

/** p11-runtime-advice: payload `runtimeAdvice` of a job draft ({text, recommended}); null when absent. */
export function adviceOf(
  p: Record<string, unknown>,
  runtime: unknown,
): { text: string; differs: boolean } | null {
  const a = rec(p.runtimeAdvice);
  if (typeof a.text !== 'string' || a.text === '') return null;
  const recommended = typeof a.recommended === 'string' ? a.recommended : null;
  return { text: a.text.slice(0, 500), differs: recommended !== null && recommended !== runtime };
}

/** p6-result-reuse: payload `reuse` of a job draft ({jobId, age}), when the master found an identical success. */
export function identicalOf(p: Record<string, unknown>): { jobId: string; age: string } | null {
  const r = rec(p.reuse);
  return typeof r.jobId === 'string' && /^[0-9a-f-]{36}$/i.test(r.jobId) && typeof r.age === 'string'
    ? { jobId: r.jobId, age: r.age }
    : null;
}

const APPROVAL_TEXT: Readonly<Record<string, string>> = {
  'ask-sensitive': 'asks for sensitive actions',
  'ask-all': 'asks for every action',
  'deny-sensitive': 'denies sensitive actions',
  'allow-all': 'never asks',
};

function limitsText(l: Record<string, unknown>): string {
  return (
    Object.entries(l)
      .map(([k, v]) => `${k} ${text(v)}`)
      .join(', ') || '—'
  );
}

type Warning = { testId: string; text: string; danger?: boolean };

/**
 * p6-automation-defaults / p6-chat-job-defaults: the master's placement check of a drafted job (payload `review`;
 * older masters: absent). No machine can run it → a danger line; machines only busy / offline → a note.
 */
function placementWarnings(review: Record<string, unknown>, prefix: string): Warning[] {
  const placement = rec(review.placement);
  if (typeof placement.warning === 'string') {
    return [{ testId: `${prefix}-placement-warning`, text: placement.warning, danger: true }];
  }
  if (typeof placement.note === 'string') {
    return [{ testId: `${prefix}-placement-note`, text: placement.note }];
  }
  return [];
}

function canRunOn(placement: Record<string, unknown>): FieldRow[] {
  return Array.isArray(placement.machines) && placement.machines.length > 0
    ? [{ label: 'Can run on', value: placement.machines.map(text).join(', ') }]
    : [];
}

function projectDefaultsOf(review: Record<string, unknown>): string[] {
  return Array.isArray(review.projectDefaults) ? review.projectDefaults.map(text) : [];
}

function approvalText(policy: unknown): string {
  return typeof policy === 'string' ? `${policy} (${APPROVAL_TEXT[policy] ?? 'policy'})` : '—';
}

/** Summaries of kinds added after p5 (p6-automations), filled below. */
const SUMMARIES_EXTRA: Record<string, (p: Record<string, unknown>) => Summary> = {};

/** p6-deploy-on-success (ADR-0030): the job deploys its result when it succeeds; confirming is the approval. */
export function deployLines(v: unknown): { label: string; value: string }[] {
  if (v === null || typeof v !== 'object') return [];
  const d = rec(v);
  const where = d.target === 'coolify' ? 'Coolify' : 'Cloudflare Pages';
  const env = d.env === 'production' ? 'production' : 'preview';
  const dir = typeof d.directory === 'string' ? ` from ${d.directory}/` : '';
  const publish = d.target === 'pages' ? publishChainLines(d, env) : [];
  return [
    {
      label: 'Deploy',
      value:
        publish.length === 0
          ? `Deploys to ${where} (${env})${dir} when it succeeds — confirming approves the deploy`
          : `Publishes to ${where} (${env})${dir} when it succeeds — confirming approves every step below at once (a fresh authenticator code when production or DNS is involved)`,
    },
    ...publish.map((value, i) => ({ label: `Step ${String(i + 1)}`, value })),
  ];
}

/**
 * p10-publish-bundle: the chain a "deploy when done" with publish fields runs (the master's `chain` lines when it
 * sent them, else built from the fields). Empty: a plain deploy to the Pages target.
 */
export function publishChainLines(d: Record<string, unknown>, env: string): string[] {
  if (Array.isArray(d.chain) && d.chain.every((c) => typeof c === 'string') && d.chain.length > 0) {
    return d.chain;
  }
  const project = typeof d.pagesProject === 'string' ? d.pagesProject : null;
  const domain = typeof d.domain === 'string' ? d.domain : null;
  const create = d.createIfMissing === true;
  if (project === null && domain === null && !create) return [];
  const name = project ?? 'the Pages target';
  return [
    ...(create ? [`Create the Pages project ${name} if it is missing`] : []),
    `Deploy the site (${env}) to ${name}`,
    ...(domain === null ? [] : [`Attach the custom domain ${domain}`]),
    ...(domain === null || d.dns === 'skip'
      ? []
      : [`Write the CNAME ${domain} → ${name}.pages.dev (allowed zone of the project)`]),
  ];
}

/** p10-verify-health: the card's "Verify when done" (absent: the project's default applies). */
export function verifyLines(v: unknown): { label: string; value: string }[] {
  if (v !== 'off' && v !== 'report' && v !== 'gate') return [];
  return [
    {
      label: 'Verify',
      value:
        v === 'off'
          ? 'Not verified automatically'
          : v === 'report'
            ? 'Verified automatically when it succeeds (report)'
            : 'Verified when it succeeds; the deploy waits until the verification passes (gate)',
    },
  ];
}

/** p6-quota-scheduling: the draft's fallback runtimes and off-peak deferral, when it has them. */
export function schedulingLines(spec: Record<string, unknown>): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  if (Array.isArray(spec.fallbacks) && spec.fallbacks.length > 0) {
    out.push({
      label: 'Fallback',
      value: spec.fallbacks
        .map((f: unknown) => {
          const o = rec(f);
          return `${text(o.runtime)}${o.model === undefined ? '' : ` · ${text(o.model)}`}`;
        })
        .join(' → '),
    });
  }
  if (spec.deferrable === true) out.push({ label: 'When', value: "the project's off-peak window" });
  return out;
}

/**
 * p8-chat-attachments-mentions: the files the job gets under in/ — `payload.inputFiles` (name, size, source job; null
 * = attached in this chat) when the master lists them, else the refs (chat attachments by count), so the user sees
 * them before confirming. Null when the master listed nothing.
 */
function inputFileLines(p: Record<string, unknown>): string[] | null {
  if (Array.isArray(p.inputFiles) && p.inputFiles.length > 0) {
    return p.inputFiles.map(rec).flatMap((f) => {
      if (typeof f.name !== 'string' || f.name === '') return [];
      const size = typeof f.sizeBytes === 'number' ? ` (${formatBytes(f.sizeBytes)})` : '';
      const from =
        typeof f.sourceJobId === 'string' ? `from job ${f.sourceJobId.slice(0, 8)}…` : 'from this chat';
      return [`${f.name.slice(0, 100)}${size} — ${from}`];
    });
  }
  return null;
}

function chatAttachmentLines(p: Record<string, unknown>): string[] {
  const ids = Array.isArray(p.chatAttachments) ? p.chatAttachments.filter((x) => typeof x === 'string') : [];
  if (ids.length === 0) return [];
  return [`${String(ids.length)} ${ids.length === 1 ? 'file' : 'files'} attached in this chat`];
}

const SUMMARIES: Readonly<Record<string, (p: Record<string, unknown>) => Summary>> = {
  job: (p) => {
    const spec = rec(p.spec);
    const repo = rec(spec.repository);
    const project = typeof p.project === 'string' ? p.project : '';
    // p5-ops-chat-next: input files from earlier jobs (ids; the master reads and checks them on confirm).
    const continueFrom = typeof p.continueFrom === 'string' ? p.continueFrom : '';
    const picked = Array.isArray(p.inputArtifacts) ? p.inputArtifacts.map(rec) : [];
    const inputs = inputFileLines(p) ?? [
      ...(continueFrom === '' ? [] : [`all results of job ${continueFrom.slice(0, 8)}…`]),
      ...picked.map((a) => `${text(a.artifactId)} of job ${text(a.jobId).slice(0, 8)}…`),
      ...chatAttachmentLines(p),
    ];
    // p6-chat-job-defaults: the master's review (project defaults it filled, placement); older masters: absent.
    const review = rec(p.review);
    const warnings = placementWarnings(review, 'job');
    const defaults = projectDefaultsOf(review);
    const identical = identicalOf(p);
    const advice = adviceOf(p, spec.runtime);
    return {
      ...(identical === null ? {} : { identical }),
      ...(advice === null ? {} : { advice }),
      key: [
        { label: 'Project', value: text(p.project) },
        ...(inputs.length === 0 ? [] : [{ label: 'Input files', value: inputs.join('; ') }]),
        {
          label: 'Runtime',
          value: `${text(spec.runtime)}${spec.model === undefined ? ' · project default model' : ` · ${text(spec.model)}`}`,
        },
        { label: 'Sandbox', value: text(spec.sandboxProfile) },
        { label: 'Approval', value: approvalText(spec.approvalPolicy) },
        ...deployLines(p.deployOnSuccess),
        ...verifyLines(p.verifyOnSuccess),
        ...schedulingLines(spec),
        ...canRunOn(rec(review.placement)),
      ],
      details: [
        repo.url === undefined
          ? { label: 'Workspace', value: 'repository-less' }
          : { label: 'Repository', value: `${text(repo.url)} @ ${text(repo.baseRef)}` },
        { label: 'Limits', value: limitsText(rec(spec.limits)) },
        ...(defaults.length > 0 ? [{ label: 'Project defaults', value: defaults.join(', ') }] : []),
        { label: 'Prompt', value: text(spec.prompt) },
      ],
      ...(warnings.length > 0 ? { warnings } : {}),
      spec,
      ...(project === ''
        ? {}
        : { prefill: { project, spec, ...(continueFrom === '' ? {} : { continueFrom }) } }),
    };
  },
  workflow_run: (p) => {
    const review = rec(p.review);
    const warnings = placementWarnings(review, 'workflow');
    return {
      key: [
        {
          label: 'Workflow',
          value:
            typeof p.workflow === 'string'
              ? `${p.workflow}${typeof p.version === 'number' ? ` v${String(p.version)}` : ''}`
              : text(p.workflowId),
        },
        ...(p.project === undefined ? [] : [{ label: 'Project', value: text(p.project) }]),
        ...(Array.isArray(p.sandboxProfiles)
          ? [{ label: 'Sandbox', value: p.sandboxProfiles.map(text).join(', ') }]
          : []),
        ...(p.approvalPolicy === undefined
          ? []
          : [{ label: 'Approval', value: approvalText(p.approvalPolicy) }]),
        ...canRunOn(rec(review.placement)),
      ],
      details: [
        {
          label: 'Inputs',
          value:
            Object.entries(rec(p.inputs))
              .map(([k, v]) => `${k} = ${text(v)}`)
              .join('\n') || '—',
        },
      ],
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },
  // p13-workflows-ui: a workflow definition (new, or the next version of a saved one); the graph is drawn apart.
  workflow: (p) => {
    const w = workflowDraftOf(p);
    return {
      key: [
        { label: 'Workflow', value: w.name || '—' },
        { label: 'Project', value: w.project || '—' },
        {
          label: 'Version',
          value:
            w.baseVersion === null
              ? 'New workflow (v1)'
              : `v${String(w.baseVersion)} → v${String(w.baseVersion + 1)}`,
        },
        {
          label: 'Steps',
          value: w.nodes
            .map((n) => `${n.id} (${n.role}${n.gate === null ? '' : `, approval: ${n.gate}`})`)
            .join(', '),
        },
      ],
      details: w.note === null ? [] : [{ label: 'Note', value: w.note }],
    };
  },
  worker_config: (p) => ({
    key: [
      { label: 'Worker', value: text(p.workerId) },
      ...Object.entries(rec(p.patch)).map(([k, v]) => ({ label: k, value: `→ ${text(v)}` })),
    ],
    details: [{ label: 'Reason', value: text(p.reason) }],
  }),
  approval_decision: (p) => ({
    key: [
      { label: 'Request', value: text(p.approvalId) },
      { label: 'Decision', value: text(p.decision) },
    ],
    details: [{ label: 'Reason', value: text(p.reason) }],
  }),
  job_message: (p) => ({
    key: [
      { label: 'Job', value: text(p.jobId) },
      { label: 'Message', value: text(p.text) },
    ],
    details: [],
  }),
  // p10-approval-pause.
  job_resume: (p) => ({
    key: [
      { label: 'Job', value: text(p.jobId) },
      { label: 'Action', value: p.mode === 'restart' ? 'Restart from scratch' : 'Resume now' },
    ],
    details: [],
  }),
  // p5-machine-admin (ADR-0021).
  machine_task: (p) => ({
    key: [
      { label: 'Machine', value: text(p.workerName ?? p.workerId) },
      {
        label: 'Approvals',
        value:
          typeof p.approvalPolicy === 'string'
            ? `${p.approvalPolicy} (${APPROVAL_TEXT[p.approvalPolicy] ?? 'policy'})`
            : '—',
      },
      {
        label: 'Max duration',
        value:
          typeof p.maxDurationSec === 'number' ? `${String(Math.round(p.maxDurationSec / 60))} min` : '—',
      },
    ],
    details: [{ label: 'Task', value: text(p.prompt) }],
    machineAdmin: {
      fullAccess: p.approvalPolicy === 'allow-all',
      note:
        p.approvalPolicy === 'allow-all'
          ? 'Elevated commands run without asking (full access is allowed for this machine); every one is logged.'
          : 'Every elevated command waits for your approval in the console.',
    },
  }),
  tool_install: (p) => ({
    key: [
      { label: 'Machine', value: text(p.workerName ?? p.workerId) },
      { label: 'Tool', value: `${text(p.tool)} ${text(p.version)}` },
    ],
    details: [],
    ...(p.elevated === true
      ? {
          machineAdmin: {
            fullAccess: false,
            note: "Needs machine administration: it runs as a machine administration job with the release's fixed install commands.",
          },
        }
      : {}),
  }),
  skill: (p) => ({
    key: [
      {
        label: 'Skill',
        value: `${text(p.skillId)} ${text(p.version)}${typeof p.baseVersion === 'string' ? ` (from ${p.baseVersion})` : ' (new)'}`,
      },
      {
        label: 'Runtimes',
        value: Array.isArray(p.runtimes) ? p.runtimes.map(text).join(', ') : text(p.runtimes),
      },
      { label: 'Change', value: text(p.changeNote) },
    ],
    details: [{ label: 'Description', value: text(p.description) }],
    notice: {
      testId: 'skill-draft-note',
      text: `Confirming signs this version with the panel skills key and publishes it${p.assignAllProjects === true ? ' to ALL projects' : ''}.`,
    },
    diff: typeof p.diff === 'string' && p.diff !== '' ? p.diff : '(no changes)',
  }),
};

/** p6-automations: one line for a trigger object as the assistant drafted it. */
export function triggerText(t: Record<string, unknown>): string {
  switch (t.kind) {
    case 'cron':
      return `Cron ${text(t.cron)} (UTC)`;
    case 'at':
      return `Once at ${text(t.at)}`;
    case 'github':
      return `GitHub ${text(t.event)}${Array.isArray(t.actions) ? ` ${t.actions.map(text).join('/')}` : ''} on ${text(t.repository)}`;
    case 'webhook':
      return 'Signed webhook (the secret is shown once after confirming)';
    case 'chain':
      return `After automation ${text(t.automationId)} ${Array.isArray(t.on) ? t.on.map(text).join(' or ') : ''}`;
    default:
      return text(t.kind);
  }
}

const AUTOMATION_ACTION: Readonly<Record<string, string>> = {
  pause: 'Pause',
  resume: 'Resume',
  delete: 'Delete',
  run_now: 'Run now',
};

SUMMARIES_EXTRA.automation = (p) => {
  const input = rec(p.input);
  const patch = rec(p.patch);
  const body = p.action === 'update' ? patch : input;
  const target = rec(body.target);
  const spec = rec(target.spec);
  const trigger = rec(body.trigger);
  // p6-automation-defaults: the master's review of the draft (older masters: absent).
  const review = rec(p.review);
  const placement = rec(review.placement);
  const timeout =
    typeof review.approvalTimeoutMinutes === 'number'
      ? `cancelled after ${String(review.approvalTimeoutMinutes)} min without a decision`
      : review.approvalTimeoutMinutes === null
        ? 'no approval timeout'
        : null;
  const warnings = placementWarnings(review, 'automation');
  if (typeof review.approvalWarning === 'string') {
    warnings.push({ testId: 'automation-approval-warning', text: review.approvalWarning });
  }
  const defaults = projectDefaultsOf(review);
  return {
    key: [
      { label: 'Action', value: p.action === 'update' ? `Change ${text(p.name)}` : 'Create' },
      ...(p.action === 'update' ? [] : [{ label: 'Project', value: text(input.project) }]),
      ...(Object.keys(trigger).length > 0 ? [{ label: 'Trigger', value: triggerText(trigger) }] : []),
      ...(Object.keys(spec).length > 0
        ? [
            { label: 'Runs', value: `${text(spec.runtime)} · ${text(spec.sandboxProfile)}` },
            ...schedulingLines(spec),
          ]
        : []),
      ...(Object.keys(spec).length > 0
        ? [
            {
              label: 'Approvals',
              value: `${text(spec.approvalPolicy)} (${APPROVAL_TEXT[text(spec.approvalPolicy)] ?? 'policy'})${timeout === null ? '' : ` · ${timeout}`}`,
            },
          ]
        : []),
      ...canRunOn(placement),
    ],
    details: [
      ...(Object.keys(spec).length > 0 ? [{ label: 'Prompt', value: text(spec.prompt) }] : []),
      ...(defaults.length > 0 ? [{ label: 'Project defaults', value: defaults.join(', ') }] : []),
      ...['concurrency', 'catchUp', 'maxRunsPerHour', 'notifyOnFailure', 'approvalTimeoutMinutes']
        .filter((k) => body[k] !== undefined)
        .map((k) => ({ label: k, value: text(body[k]) })),
    ],
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(Object.keys(spec).length > 0 ? { spec } : {}),
    ...(trigger.kind === 'github' || trigger.kind === 'webhook'
      ? {
          notice: {
            testId: 'automation-external-note',
            text: 'This automation starts jobs from outside (GitHub or a webhook call). Event content reaches the agent only as untrusted data.',
          },
        }
      : {}),
  };
};
SUMMARIES_EXTRA.automation_change = (p) => ({
  key: [
    { label: 'Automation', value: text(p.name ?? p.automationId) },
    { label: 'Action', value: AUTOMATION_ACTION[text(p.action)] ?? text(p.action) },
    ...(p.project === undefined ? [] : [{ label: 'Project', value: text(p.project) }]),
  ],
  details: [],
});

/**
 * p6-deploy-integrations: a deploy / restart / Pages deploy / DNS change, or the rollback of an earlier action.
 * The master previewed it (target, diff, policy) when the assistant drafted it; confirming only *requests* it.
 */
SUMMARIES_EXTRA.ops_action = (p) => {
  const review = rec(p.review);
  const request = rec(p.request);
  const rollback = rec(p.rollback);
  const isRollback = Object.keys(rollback).length > 0;
  const policy = rec(review.policy);
  const diff = rec(review.diff);
  const decision = text(policy.decision);
  const target = rec(review.target);
  const resources = Array.isArray(target.resources)
    ? target.resources.map((r) => text(rec(r).name ?? rec(r).uuid)).join(', ')
    : typeof target.name === 'string'
      ? `${text(target.type)} ${target.name}`
      : typeof target.project === 'string'
        ? `Pages ${target.project}`
        : '';
  const warnings: { testId: string; text: string; danger?: boolean }[] = [];
  if (!isRollback) {
    warnings.push({
      testId: 'ops-policy',
      text: decisionText(decision, typeof policy.reason === 'string' ? policy.reason : undefined),
      ...(decision === 'refused' ? { danger: true } : {}),
    });
  } else {
    warnings.push({
      testId: 'ops-policy',
      text: 'The rollback is a new action: the project policy decides whether it waits for an approval.',
    });
  }
  return {
    key: [
      {
        label: 'Action',
        value: isRollback ? `Roll back ${kindText(text(review.kind))}` : kindText(text(request.kind)),
      },
      ...(request.project === undefined ? [] : [{ label: 'Project', value: text(request.project) }]),
      ...(review.env === undefined || review.env === null
        ? []
        : [{ label: 'Environment', value: text(review.env) }]),
      ...(resources === '' ? [] : [{ label: 'Target', value: resources }]),
      ...(isRollback ? [{ label: 'Rolls back', value: text(rollback.actionId) }] : []),
    ],
    details: typeof request.note === 'string' ? [{ label: 'Note', value: request.note }] : [],
    warnings,
    ...(Object.keys(diff).length > 0 ? { opsDiff: diff } : {}),
  };
};

/** p8-uptime: one monitor, or the "Monitor this" set of an Outputs site (confirming creates it). */
// p10-chat-job-actions: the jobs themselves are listed (with a checkbox each) by JobActionJobs.
SUMMARIES_EXTRA.job_action = (p) => ({
  notice: { testId: 'job-action-effect', text: jobActionEffect(p) },
  key: [
    { label: 'Action', value: jobActionLabel(p.action) },
    { label: 'Jobs', value: String(actionJobs(p).length) },
    ...(typeof p.reason === 'string' ? [{ label: 'Reason', value: p.reason }] : []),
    ...(isPriorityClass(p.priorityClass)
      ? [{ label: 'Class', value: PRIORITY_CLASS_LABEL[p.priorityClass] }]
      : []),
  ],
  details: typeof p.prompt === 'string' ? [{ label: 'Prompt', value: p.prompt }] : [],
});

/** p11-memory-layers: where a memory_change card's record lives, in words. */
function memoryTarget(scope: unknown): string {
  if (typeof scope !== 'string' || scope === '') return 'the project memory';
  if (scope.startsWith('user')) return 'your personal rules';
  if (scope === 'global') return 'the global memory';
  const plus = /^project:([^+]+)\+runtime:(.+)$/.exec(scope);
  if (plus !== null) return `project ${plus[1] ?? ''} (${scopeLabel(scope).replace('Project · ', '')})`;
  if (scope.startsWith('project:')) return `project ${scope.slice('project:'.length)}`;
  return scopeLabel(scope);
}

function memoryType(v: unknown): string {
  const t = RECORD_TYPES.find((x) => x === v);
  return t === undefined ? 'record' : TYPE_LABEL[t].toLowerCase();
}

/** "Add rule to project X: …", "Replace decision 1234abcd… with: …", "Retire record 1234abcd…". */
export function memoryChangeText(p: Record<string, unknown>): string {
  const type = memoryType(p.type);
  const statement = typeof p.statement === 'string' ? p.statement : '';
  const id = typeof p.recordId === 'string' ? `${p.recordId.slice(0, 8)}…` : '';
  switch (p.action) {
    case 'replace':
      return `Replace ${type} ${id} in ${memoryTarget(p.scope)} with: ${statement}`;
    case 'retire':
      return `Retire ${type} ${id}${typeof p.reason === 'string' && p.reason !== '' ? ` (${p.reason})` : ''}: new jobs stop getting it.`;
    default:
      return `Add ${type} to ${memoryTarget(p.scope)}: ${statement}`;
  }
}

SUMMARIES_EXTRA.memory_change = (p) => ({
  notice: { testId: 'memory-change-text', text: memoryChangeText(p) },
  key: [
    { label: 'Action', value: p.action === 'replace' ? 'Replace' : p.action === 'retire' ? 'Retire' : 'Add' },
    ...(p.type === undefined ? [] : [{ label: 'Type', value: memoryType(p.type) }]),
    ...(typeof p.scope === 'string' ? [{ label: 'Where', value: memoryTarget(p.scope) }] : []),
    ...(typeof p.statement === 'string' ? [{ label: 'Statement', value: p.statement }] : []),
    ...(typeof p.recordId === 'string' ? [{ label: 'Record', value: p.recordId }] : []),
  ],
  details: [
    ...(typeof p.rationale === 'string' ? [{ label: 'Rationale', value: p.rationale }] : []),
    ...(typeof p.consequences === 'string' ? [{ label: 'Consequences', value: p.consequences }] : []),
    ...(typeof p.decidedOn === 'string' ? [{ label: 'Decided on', value: p.decidedOn }] : []),
    ...(typeof p.reviewBy === 'string' ? [{ label: 'Review by', value: p.reviewBy }] : []),
    ...(typeof p.reason === 'string' ? [{ label: 'Reason', value: p.reason }] : []),
  ],
});

/** p11-memory-layers: where the confirmed memory change can be seen. */
export function memoryChangeHref(d: Pick<ChatDraft, 'payload' | 'project'>, recordId: string): string {
  const scope = typeof d.payload.scope === 'string' ? d.payload.scope : '';
  if (scope.startsWith('user')) return '/settings/profile#personal-rules';
  const project = scope.startsWith('project:')
    ? (scope.slice('project:'.length).split('+')[0] ?? null)
    : d.project;
  const id = encodeURIComponent(recordId);
  return project !== null && project !== ''
    ? `/projects/${encodeURIComponent(project)}?tab=memory&record=${id}`
    : `/settings/context?record=${id}`;
}

SUMMARIES_EXTRA.monitor = (p) => {
  if (p.mode === 'output') {
    return {
      key: [
        { label: 'Project', value: text(p.project) },
        { label: 'Site', value: text(p.outputKey) },
        { label: 'Checks', value: 'its address and its Cloudflare Pages / Coolify status' },
      ],
      details: [],
    };
  }
  const input = rec(p.input);
  const config = rec(input.config);
  const target =
    input.type === 'http'
      ? `${text(config.method ?? 'GET')} ${text(config.url)}`
      : input.type === 'tcp'
        ? `${text(config.host)}:${text(config.port)}`
        : input.type === 'pages'
          ? `Cloudflare Pages ${text(config.project)} (${text(config.env ?? 'production')})`
          : `Coolify app ${text(config.uuid)}`;
  return {
    key: [
      { label: 'Name', value: text(input.name) },
      { label: 'Project', value: text(input.project) },
      { label: 'Checks', value: target },
      {
        label: 'Every',
        value: `${text(input.intervalSec ?? (input.type === 'pages' || input.type === 'coolify' ? 300 : 60))} s`,
      },
    ],
    details: Object.entries(config)
      .filter(([k]) => !['url', 'method', 'host', 'port', 'project', 'env', 'uuid'].includes(k))
      .map(([k, v]) => ({ label: k, value: text(v) })),
  };
};

/** Unknown kinds: short top-level values on the card, everything (as text) behind "Details". */
export function fallbackSummary(p: Record<string, unknown>): Summary {
  const entries = Object.entries(p);
  const short = entries.filter(
    ([, v]) => (typeof v === 'string' && v.length <= 80) || typeof v === 'number' || typeof v === 'boolean',
  );
  const spec = rec(p.spec);
  return {
    key: short.slice(0, 4).map(([k, v]) => ({ label: k, value: text(v) })),
    details: entries
      .filter(([k]) => !short.slice(0, 4).some(([s]) => s === k))
      .map(([k, v]) => ({ label: k, value: text(v) })),
    ...(Object.keys(spec).length > 0 ? { spec } : {}),
  };
}

export function summarizeDraft(d: ChatDraft): Summary {
  const fn = SUMMARIES[d.kind] ?? SUMMARIES_EXTRA[d.kind];
  return fn === undefined ? fallbackSummary(d.payload) : fn(d.payload);
}

/** The approval mode a job / machine-task draft proposes (null: no mode on this kind of draft). */
export function draftApprovalPolicy(d: Pick<ChatDraft, 'kind' | 'payload'>): string | null {
  if (d.kind === 'job') {
    const spec = rec(d.payload.spec);
    return typeof spec.approvalPolicy === 'string' ? spec.approvalPolicy : 'ask-sensitive';
  }
  if (d.kind === 'machine_task') return d.payload.approvalPolicy === 'allow-all' ? 'allow-all' : 'ask-all';
  return null;
}

/** p9-queue-priority: the class a job / workflow-run draft proposes (null: no class on this kind of draft). */
export function draftPriorityClass(d: Pick<ChatDraft, 'kind' | 'payload'>): PriorityClass | null {
  if (d.kind !== 'job' && d.kind !== 'workflow_run') return null;
  return isPriorityClass(d.payload.priorityClass) ? d.payload.priorityClass : 'normal';
}
