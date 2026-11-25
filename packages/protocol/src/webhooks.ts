import { z } from 'zod';

/**
 * p16-webhooks-out (docs/design/p16-webhooks-out.md, ADR-0059): the outgoing webhook event catalog — the versioned,
 * documented contract between the master and an external automation receiver (n8n, Zapier, a CI, a chat bot).
 *
 * Every delivery is one JSON object, the {@link WebhookEnvelope}: `id` (the event id — the same event delivered to
 * two subscriptions has the same id), `type` (one of {@link WEBHOOK_EVENT_TYPES}), `catalogVersion`, `occurredAt`,
 * `project` (null for global events) and `data` (the per-type object below).
 *
 * Payloads carry identifiers, titles, names, enumerations (states, triggers, kinds), counts and console links — never
 * a secret, a prompt, an agent's output, a log line or a provider's error text. The only free text beyond titles and
 * names is the opt-in `details` field set (a subscription's "include details"): a failure reason or an approval's
 * summary, passed through the secret redactor and cut to {@link DETAIL_MAX} characters. Every data schema is strict, so
 * the master cannot send a field this catalog does not document (the producer validates before storing).
 *
 * Compatibility: within a catalog version fields are only ever added (receivers must ignore unknown fields); a field
 * is never removed or changes meaning. A breaking change is a new `catalogVersion` with both versions served for a
 * transition period.
 */
export const WEBHOOK_CATALOG_VERSION = 1;

/** Header names (lower case on the wire; HTTP header names are case-insensitive). */
export const WEBHOOK_HEADERS = {
  /** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">` (one `v1` per active secret during a rotation). */
  signature: 'x-remyral-signature',
  /** The delivery id: stable across retries and redeliveries of the same delivery — the receiver's idempotency key. */
  delivery: 'x-remyral-delivery',
  /** The event id (same as the body's `id`). */
  eventId: 'x-remyral-event-id',
  /** The event type (same as the body's `type`). */
  event: 'x-remyral-event',
  /** 1 for the first attempt, then 2, 3 … (a manual redelivery continues the count). */
  attempt: 'x-remyral-attempt',
} as const;

/** The longest opt-in detail text (characters, after redaction). */
export const DETAIL_MAX = 500;

export const WEBHOOK_EVENT_TYPES = [
  'job.created',
  'job.started',
  'job.succeeded',
  'job.failed',
  'job.cancelled',
  'job.awaiting_approval',
  'approval.requested',
  'approval.decided',
  'merge.decided',
  'deploy.started',
  'deploy.succeeded',
  'deploy.failed',
  'workflow.run.started',
  'workflow.run.succeeded',
  'workflow.run.failed',
  'workflow.run.cancelled',
  'automation.run.started',
  'automation.run.succeeded',
  'automation.run.failed',
  'worker.online',
  'worker.offline',
  'release.rollout_paused',
  'secret.expiring',
  'cost.brake',
  /** Sent only by "Send test" (Ayarlar → Webhook'lar); never produced by an event and never needs subscribing. */
  'webhook.test',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** Types a subscription can filter on (everything except `webhook.test`). */
export const SUBSCRIBABLE_EVENT_TYPES = WEBHOOK_EVENT_TYPES.filter(
  (t): t is Exclude<WebhookEventType, 'webhook.test'> => t !== 'webhook.test',
);
export type SubscribableEventType = (typeof SUBSCRIBABLE_EVENT_TYPES)[number];

/** Global events have `project: null`; a project-scoped subscription never receives them. */
export const GLOBAL_EVENT_TYPES: readonly WebhookEventType[] = [
  'worker.online',
  'worker.offline',
  'release.rollout_paused',
  'secret.expiring',
];

export function isWebhookEventType(v: unknown): v is WebhookEventType {
  return typeof v === 'string' && (WEBHOOK_EVENT_TYPES as readonly string[]).includes(v);
}

export function isSubscribableEventType(v: unknown): v is SubscribableEventType {
  return isWebhookEventType(v) && v !== 'webhook.test';
}

/** Event groups for the console's filter picker (prefix → types). */
export const WEBHOOK_EVENT_GROUPS = {
  job: [
    'job.created',
    'job.started',
    'job.succeeded',
    'job.failed',
    'job.cancelled',
    'job.awaiting_approval',
  ],
  approval: ['approval.requested', 'approval.decided', 'merge.decided'],
  deploy: ['deploy.started', 'deploy.succeeded', 'deploy.failed'],
  workflow: [
    'workflow.run.started',
    'workflow.run.succeeded',
    'workflow.run.failed',
    'workflow.run.cancelled',
  ],
  automation: ['automation.run.started', 'automation.run.succeeded', 'automation.run.failed'],
  fleet: ['worker.online', 'worker.offline', 'release.rollout_paused'],
  safety: ['secret.expiring', 'cost.brake'],
} as const satisfies Record<string, readonly SubscribableEventType[]>;

// ------------------------------------------------------------------------------------------------ shared pieces

const Id = z.string().min(1).max(128);
const Uuid = z.uuid();
const Iso = z.iso.datetime({ offset: true });
const Title = z.string().max(300);
/** An absolute console URL (when the master knows its public origin) or a console-relative path. */
const Link = z.string().max(600);
/** The opt-in detail text (redacted, at most DETAIL_MAX characters); absent unless the subscription includes details. */
const Detail = z.string().max(DETAIL_MAX).optional();

/** Who caused it: a person (console, chat or an API token), the master itself, or a machine. */
const ActorType = z.enum(['user', 'system', 'worker']);

const JobRef = z.strictObject({
  id: Uuid,
  title: Title,
  project: Id,
  /** The job's state right after the event. */
  state: z.string().max(32),
  runtime: z.string().max(32).nullable(),
  link: Link,
});

export const JobEventData = z.strictObject({
  job: JobRef,
  transition: z.strictObject({
    from: z.string().max(32).nullable(),
    to: z.string().max(32),
    trigger: z.string().max(48),
  }),
  actor: z.strictObject({ type: ActorType }),
  /** Opt-in: the transition's reason (e.g. why a job failed), redacted. */
  reason: Detail,
});

const ApprovalRef = z.strictObject({
  id: Uuid,
  /** The guarded action (e.g. `git.merge`, `deploy.production`, `shell.exec`). */
  action: z.string().max(64),
  /** `gate` (the job waits in AWAITING_APPROVAL) or `in_run` (the running agent asked). */
  kind: z.string().max(16),
  risk: z.string().max(16).nullable(),
  link: Link,
});

export const ApprovalRequestedData = z.strictObject({
  approval: ApprovalRef.extend({ expiresAt: Iso.nullable() }),
  job: JobRef.pick({ id: true, title: true, project: true, link: true }),
  /** Opt-in: the request's summary sentence, redacted. */
  summary: Detail,
});

export const ApprovalDecidedData = z.strictObject({
  approval: ApprovalRef.extend({
    status: z.enum(['approved', 'denied', 'expired', 'cancelled']),
    approvals: z.number().int().min(0),
    requiredApprovals: z.number().int().min(0),
  }),
  job: JobRef.pick({ id: true, title: true, project: true, link: true }),
  decidedBy: z.strictObject({ type: ActorType }),
  /** Opt-in: the decider's reason, redacted. */
  reason: Detail,
});

/** The protected merge decision of a job's branch (a `git.merge` approval decided). */
export const MergeDecidedData = z.strictObject({
  job: JobRef.pick({ id: true, title: true, project: true, link: true }),
  approvalId: Uuid,
  decision: z.enum(['approved', 'denied', 'expired', 'cancelled']),
  decidedBy: z.strictObject({ type: ActorType }),
});

export const DeployEventData = z.strictObject({
  deploy: z.strictObject({
    id: Uuid,
    /** The ops action kind (`coolify.deploy`, `pages.deploy`, `pages.publish`, …). */
    kind: z.string().max(32),
    env: z.enum(['preview', 'production']).nullable(),
    project: Id,
    state: z.string().max(32),
    /** What it deploys to, as the console shows it (application / Pages project name); never a token. */
    target: z.string().max(200).nullable(),
    /** The job whose result is deployed, when there is one. */
    jobId: Uuid.nullable(),
    /** The live URL(s) after success, when the provider reported them. */
    urls: z.array(z.string().max(600)).max(10),
    via: z.string().max(16),
    link: Link,
  }),
  /** Opt-in: the failure sentence, redacted. */
  error: Detail,
});

export const WorkflowRunEventData = z.strictObject({
  run: z.strictObject({
    id: Uuid,
    workflowId: Uuid,
    workflowName: Title,
    project: Id,
    state: z.string().max(32),
    trigger: z.string().max(32).nullable(),
    link: Link,
  }),
  /** Opt-in: the reason a run failed or was cancelled, redacted. */
  reason: Detail,
});

export const AutomationRunEventData = z.strictObject({
  run: z.strictObject({
    id: Uuid,
    automationId: Uuid,
    automationName: Title,
    project: Id,
    state: z.string().max(32),
    trigger: z.string().max(32),
    jobId: Uuid.nullable(),
    workflowRunId: Uuid.nullable(),
    link: Link,
  }),
  reason: Detail,
});

export const WorkerEventData = z.strictObject({
  worker: z.strictObject({
    id: Id,
    name: Title,
    os: z.string().max(32).nullable(),
    arch: z.string().max(32).nullable(),
    version: z.string().max(64).nullable(),
    link: Link,
  }),
  /** worker.offline: the WebSocket close code (1000 normal, 1001 going away, 1006 lost, 4xxx protocol). */
  closeCode: z.number().int().nullable(),
});

export const RolloutPausedData = z.strictObject({
  rollout: z.strictObject({
    holdId: Uuid,
    channel: z.string().max(16),
    version: z.string().max(64),
    rolloutPercent: z.number().int().min(0).max(100),
    previousVersion: z.string().max(64).nullable(),
    reason: z.enum(['update_failures', 'job_failures', 'manual']),
    link: Link,
  }),
});

export const SecretExpiringData = z.strictObject({
  secret: z.strictObject({
    /** The item of Ayarlar → Operasyon güvenliği (e.g. `cloudflare:token`, `tls:public-origin`) — a name, no value. */
    item: z.string().max(100),
    dueAt: Iso.nullable(),
    /** Days before the due date this notice is for (30, 14, 7, 1), 0 = expired. */
    thresholdDays: z.number().int().min(0).max(30),
    link: Link,
  }),
});

export const CostBrakeData = z.strictObject({
  brake: z.strictObject({
    /** `global` or a project id. */
    scope: Id,
    window: z.enum(['day', 'month']),
    windowStart: Iso.nullable(),
    level: z.enum(['warning', 'exceeded']),
    spentUsd: z.number().min(0),
    limitUsd: z.number().min(0),
    mode: z.enum(['warn', 'block']),
    link: Link,
  }),
});

export const WebhookTestData = z.strictObject({
  subscriptionId: Uuid,
  message: z.string().max(200),
});

/** Data schema per event type. */
export const WEBHOOK_DATA_SCHEMAS = {
  'job.created': JobEventData,
  'job.started': JobEventData,
  'job.succeeded': JobEventData,
  'job.failed': JobEventData,
  'job.cancelled': JobEventData,
  'job.awaiting_approval': JobEventData,
  'approval.requested': ApprovalRequestedData,
  'approval.decided': ApprovalDecidedData,
  'merge.decided': MergeDecidedData,
  'deploy.started': DeployEventData,
  'deploy.succeeded': DeployEventData,
  'deploy.failed': DeployEventData,
  'workflow.run.started': WorkflowRunEventData,
  'workflow.run.succeeded': WorkflowRunEventData,
  'workflow.run.failed': WorkflowRunEventData,
  'workflow.run.cancelled': WorkflowRunEventData,
  'automation.run.started': AutomationRunEventData,
  'automation.run.succeeded': AutomationRunEventData,
  'automation.run.failed': AutomationRunEventData,
  'worker.online': WorkerEventData,
  'worker.offline': WorkerEventData,
  'release.rollout_paused': RolloutPausedData,
  'secret.expiring': SecretExpiringData,
  'cost.brake': CostBrakeData,
  'webhook.test': WebhookTestData,
} as const satisfies Record<WebhookEventType, z.ZodType>;

export type WebhookData<T extends WebhookEventType> = z.infer<(typeof WEBHOOK_DATA_SCHEMAS)[T]>;

/** The envelope without type-specific validation of `data` (see {@link parseWebhookEnvelope}). */
export const WebhookEnvelope = z.strictObject({
  id: Uuid,
  type: z.enum(WEBHOOK_EVENT_TYPES),
  catalogVersion: z.literal(WEBHOOK_CATALOG_VERSION),
  occurredAt: Iso,
  project: Id.nullable(),
  data: z.record(z.string(), z.unknown()),
});
export type WebhookEnvelope = z.infer<typeof WebhookEnvelope>;

/** Validates an envelope and its `data` against the type's schema (producer side; receivers may use it too). */
export function parseWebhookEnvelope(
  value: unknown,
): { ok: true; envelope: WebhookEnvelope } | { ok: false; error: string } {
  const env = WebhookEnvelope.safeParse(value);
  if (!env.success) return { ok: false, error: env.error.issues[0]?.message ?? 'invalid envelope' };
  const data = WEBHOOK_DATA_SCHEMAS[env.data.type].safeParse(env.data.data);
  if (!data.success) {
    const issue = data.error.issues[0];
    return {
      ok: false,
      error: `${env.data.type}: ${issue?.path.join('.') ?? ''} ${issue?.message ?? 'invalid'}`,
    };
  }
  if (GLOBAL_EVENT_TYPES.includes(env.data.type) && env.data.project !== null) {
    return { ok: false, error: `${env.data.type} is a global event (project must be null)` };
  }
  return { ok: true, envelope: env.data };
}

// ------------------------------------------------------------------------------------------------ documentation

/** One line per type for the API page and the console's filter picker (English; the console translates). */
export const WEBHOOK_EVENT_DESCRIPTIONS: Readonly<Record<WebhookEventType, string>> = {
  'job.created': 'A job was created (submitted).',
  'job.started': 'A job’s agent started running on a machine.',
  'job.succeeded': 'A job finished successfully.',
  'job.failed': 'A job failed for good (no retry left).',
  'job.cancelled': 'A job was cancelled.',
  'job.awaiting_approval': 'A job’s verified result waits for an approval (the gate).',
  'approval.requested': 'An approval was requested (a gate or an agent’s in-run action).',
  'approval.decided': 'An approval was approved or denied by a person.',
  'merge.decided': 'The protected merge of a job’s branch was approved or denied.',
  'deploy.started': 'A deploy (or restart, rollback, publish) started.',
  'deploy.succeeded': 'A deploy finished and is live.',
  'deploy.failed': 'A deploy failed.',
  'workflow.run.started': 'A workflow run started.',
  'workflow.run.succeeded': 'A workflow run succeeded.',
  'workflow.run.failed': 'A workflow run failed.',
  'workflow.run.cancelled': 'A workflow run was cancelled.',
  'automation.run.started': 'An automation fired and started its job, workflow or deploy.',
  'automation.run.succeeded': 'An automation run succeeded.',
  'automation.run.failed': 'An automation run failed, errored or was cancelled.',
  'worker.online': 'A machine connected to the master.',
  'worker.offline': 'A machine’s connection to the master ended.',
  'release.rollout_paused': 'The worker rollout was held (circuit breaker or an administrator).',
  'secret.expiring': 'A key, token or certificate expires soon or has expired (30 / 14 / 7 / 1 days, 0).',
  'cost.brake': 'Model spend reached the warning level or the ceiling of the cost brake.',
  'webhook.test': 'A test delivery from Ayarlar → Webhook’lar.',
};

const EX_ID = '6f1c2b9e-4d3a-4e8b-9a51-0c2d7e5f8a10';
const EX_JOB = 'b7a1e3c2-9f40-4d6e-8c21-5a3f9e0d7b14';
const EX_TIME = '2026-10-23T09:30:00.000Z';
const EX_LINK = 'https://remyral.example.com';

const exJob = {
  id: EX_JOB,
  title: 'Fix the login redirect',
  project: 'website',
  link: `${EX_LINK}/jobs/${EX_JOB}`,
};

/** One example `data` per type (documentation and tests; each one parses against its schema). */
export const WEBHOOK_EXAMPLES: { readonly [T in WebhookEventType]: WebhookData<T> } = {
  'job.created': {
    job: { ...exJob, state: 'QUEUED', runtime: 'claude-code' },
    transition: { from: null, to: 'QUEUED', trigger: 'submit' },
    actor: { type: 'user' },
  },
  'job.started': {
    job: { ...exJob, state: 'RUNNING', runtime: 'claude-code' },
    transition: { from: 'STARTING', to: 'RUNNING', trigger: 'runtime_started' },
    actor: { type: 'worker' },
  },
  'job.succeeded': {
    job: { ...exJob, state: 'SUCCEEDED', runtime: 'claude-code' },
    transition: { from: 'VERIFYING', to: 'SUCCEEDED', trigger: 'verification_passed_no_approval' },
    actor: { type: 'system' },
  },
  'job.failed': {
    job: { ...exJob, state: 'FAILED', runtime: 'codex' },
    transition: { from: 'RUNNING', to: 'FAILED', trigger: 'attempt_failed' },
    actor: { type: 'worker' },
    reason: 'The test suite failed (3 tests).',
  },
  'job.cancelled': {
    job: { ...exJob, state: 'CANCELLED', runtime: 'claude-code' },
    transition: { from: 'CANCELLING', to: 'CANCELLED', trigger: 'cancel_confirmed' },
    actor: { type: 'worker' },
  },
  'job.awaiting_approval': {
    job: { ...exJob, state: 'AWAITING_APPROVAL', runtime: 'claude-code' },
    transition: { from: 'VERIFYING', to: 'AWAITING_APPROVAL', trigger: 'verification_passed' },
    actor: { type: 'system' },
  },
  'approval.requested': {
    approval: {
      id: EX_ID,
      action: 'git.merge',
      kind: 'gate',
      risk: 'high',
      expiresAt: '2026-10-24T09:30:00.000Z',
      link: `${EX_LINK}/approvals`,
    },
    job: exJob,
  },
  'approval.decided': {
    approval: {
      id: EX_ID,
      action: 'git.merge',
      kind: 'gate',
      risk: 'high',
      status: 'approved',
      approvals: 1,
      requiredApprovals: 1,
      link: `${EX_LINK}/approvals`,
    },
    job: exJob,
    decidedBy: { type: 'user' },
  },
  'merge.decided': { job: exJob, approvalId: EX_ID, decision: 'approved', decidedBy: { type: 'user' } },
  'deploy.started': {
    deploy: {
      id: EX_ID,
      kind: 'coolify.deploy',
      env: 'production',
      project: 'website',
      state: 'executing',
      target: 'website-prod',
      jobId: EX_JOB,
      urls: [],
      via: 'api',
      link: `${EX_LINK}/deploys/${EX_ID}`,
    },
  },
  'deploy.succeeded': {
    deploy: {
      id: EX_ID,
      kind: 'pages.deploy',
      env: 'production',
      project: 'website',
      state: 'succeeded',
      target: 'website',
      jobId: EX_JOB,
      urls: ['https://website.example.com'],
      via: 'chat',
      link: `${EX_LINK}/deploys/${EX_ID}`,
    },
  },
  'deploy.failed': {
    deploy: {
      id: EX_ID,
      kind: 'coolify.deploy',
      env: 'production',
      project: 'website',
      state: 'failed',
      target: 'website-prod',
      jobId: null,
      urls: [],
      via: 'automation',
      link: `${EX_LINK}/deploys/${EX_ID}`,
    },
    error: 'Coolify reports the build failed.',
  },
  'workflow.run.started': {
    run: {
      id: EX_ID,
      workflowId: EX_JOB,
      workflowName: 'Nightly release',
      project: 'website',
      state: 'running',
      trigger: 'schedule',
      link: `${EX_LINK}/workflows/${EX_JOB}/runs/${EX_ID}`,
    },
  },
  'workflow.run.succeeded': {
    run: {
      id: EX_ID,
      workflowId: EX_JOB,
      workflowName: 'Nightly release',
      project: 'website',
      state: 'succeeded',
      trigger: 'schedule',
      link: `${EX_LINK}/workflows/${EX_JOB}/runs/${EX_ID}`,
    },
  },
  'workflow.run.failed': {
    run: {
      id: EX_ID,
      workflowId: EX_JOB,
      workflowName: 'Nightly release',
      project: 'website',
      state: 'failed',
      trigger: 'manual',
      link: `${EX_LINK}/workflows/${EX_JOB}/runs/${EX_ID}`,
    },
  },
  'workflow.run.cancelled': {
    run: {
      id: EX_ID,
      workflowId: EX_JOB,
      workflowName: 'Nightly release',
      project: 'website',
      state: 'cancelled',
      trigger: 'manual',
      link: `${EX_LINK}/workflows/${EX_JOB}/runs/${EX_ID}`,
    },
  },
  'automation.run.started': {
    run: {
      id: EX_ID,
      automationId: EX_JOB,
      automationName: 'Fix failing CI',
      project: 'website',
      state: 'running',
      trigger: 'github',
      jobId: EX_JOB,
      workflowRunId: null,
      link: `${EX_LINK}/automations/${EX_JOB}`,
    },
  },
  'automation.run.succeeded': {
    run: {
      id: EX_ID,
      automationId: EX_JOB,
      automationName: 'Fix failing CI',
      project: 'website',
      state: 'succeeded',
      trigger: 'github',
      jobId: EX_JOB,
      workflowRunId: null,
      link: `${EX_LINK}/automations/${EX_JOB}`,
    },
  },
  'automation.run.failed': {
    run: {
      id: EX_ID,
      automationId: EX_JOB,
      automationName: 'Fix failing CI',
      project: 'website',
      state: 'failed',
      trigger: 'schedule',
      jobId: EX_JOB,
      workflowRunId: null,
      link: `${EX_LINK}/automations/${EX_JOB}`,
    },
  },
  'worker.online': {
    worker: {
      id: 'wkr_linux_01',
      name: 'linux-01',
      os: 'linux',
      arch: 'x64',
      version: '1.0.72',
      link: `${EX_LINK}/machines/wkr_linux_01`,
    },
    closeCode: null,
  },
  'worker.offline': {
    worker: {
      id: 'wkr_linux_01',
      name: 'linux-01',
      os: 'linux',
      arch: 'x64',
      version: '1.0.72',
      link: `${EX_LINK}/machines/wkr_linux_01`,
    },
    closeCode: 1006,
  },
  'release.rollout_paused': {
    rollout: {
      holdId: EX_ID,
      channel: 'stable',
      version: '1.0.73',
      rolloutPercent: 25,
      previousVersion: '1.0.72',
      reason: 'update_failures',
      link: `${EX_LINK}/settings/releases`,
    },
  },
  'secret.expiring': {
    secret: {
      item: 'cloudflare:token',
      dueAt: '2026-11-01T00:00:00.000Z',
      thresholdDays: 14,
      link: `${EX_LINK}/settings/ops-safety`,
    },
  },
  'cost.brake': {
    brake: {
      scope: 'website',
      window: 'day',
      windowStart: '2026-10-23T00:00:00.000Z',
      level: 'exceeded',
      spentUsd: 51.2,
      limitUsd: 50,
      mode: 'block',
      link: `${EX_LINK}/settings/ops-safety`,
    },
  },
  'webhook.test': { subscriptionId: EX_ID, message: 'Test delivery from Remyral.' },
};

/** A complete example envelope for a type (documentation). */
export function exampleEnvelope(type: WebhookEventType): WebhookEnvelope {
  const global = GLOBAL_EVENT_TYPES.includes(type) || type === 'webhook.test';
  return {
    id: EX_ID,
    type,
    catalogVersion: WEBHOOK_CATALOG_VERSION,
    occurredAt: EX_TIME,
    project: global ? null : 'website',
    data: WEBHOOK_EXAMPLES[type],
  };
}
