import { z } from 'zod';
import { PreviewName, PreviewPort } from './previews.js';

/**
 * p15-watches — Takipler (docs/design/p15-watches.md): the typed, deterministic conditions of a watch the assistant
 * composes from the user's sentence ("tünel ayağa kalkınca linki ver", "localhost:3000 cevap verince haber ver").
 * Fixed kinds and bounded fields only — no free-form code; the one expression language is JSONata (`expect.jsonata`),
 * evaluated in the master's sandbox pool. Event kinds are evaluated in SQL when the row changes; `http` and
 * `worker_probe` run as `function` jobs on workers (never on the master).
 */

export const WATCH_CHECK_LIMITS = {
  /** Polling of external checks: never more often than this. */
  minEverySec: 30,
  defaultEverySec: 60,
  /** Backoff ceiling (×1.5 per unmet check). */
  maxEverySec: 900,
  backoffFactor: 1.5,
  maxChecks: 500,
  minTimeoutMinutes: 5,
  defaultTimeoutMinutes: 360,
  maxTimeoutMinutes: 7 * 24 * 60,
  maxContains: 200,
  maxJsonata: 500,
  maxLabel: 120,
  /** Check jobs in flight per user. */
  maxInFlightPerUser: 3,
  /** The dry test waits this long for a worker's first result. */
  dryWaitMs: 25_000,
} as const;

const Uuid = z.uuid();
const Project = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/, 'project id');
/** A machine id (`wrk_…`) or its display name. */
const WorkerRef = z.string().min(1).max(64);
const Contains = z.string().min(1).max(WATCH_CHECK_LIMITS.maxContains);

/** What an HTTP answer must look like; every given part must hold (status default: 200–399). */
export const WatchHttpExpect = z.strictObject({
  status: z.array(z.number().int().min(100).max(599)).min(1).max(20).optional(),
  bodyContains: Contains.optional(),
  /** JSONata over `{status, headers, body}`: truthy = met; the value is what the watch delivers. */
  jsonata: z.string().min(1).max(WATCH_CHECK_LIMITS.maxJsonata).optional(),
});
export type WatchHttpExpect = z.infer<typeof WatchHttpExpect>;

export const WATCH_JOB_STATES = [
  'finished',
  'succeeded',
  'failed',
  'cancelled',
  'needs_you',
  'running',
  // p19-watch-deploy: the job's verified result was merged into its target branch (job_git.merged_sha).
  'merged',
] as const;
export const WATCH_RUN_STATES = ['finished', 'succeeded', 'failed', 'cancelled', 'waiting'] as const;
export const WATCH_EVENT_KINDS = [
  'message',
  'tool_call',
  'tool_result',
  'status',
  'error',
  'notice',
] as const;

export const WatchCheckCondition = z.discriminatedUnion('kind', [
  /** A job reached one of the states (needs_you = waits for an approval / an answer, or paused for one). */
  z.strictObject({
    kind: z.literal('job_state'),
    jobId: Uuid,
    states: z.array(z.enum(WATCH_JOB_STATES)).min(1).max(7),
  }),
  /** A job's event stream shows a line containing `contains` (case-insensitive; no regex). */
  z.strictObject({
    kind: z.literal('job_event'),
    jobId: Uuid,
    contains: Contains,
    eventKinds: z.array(z.enum(WATCH_EVENT_KINDS)).min(1).max(6).optional(),
  }),
  /** A job stored an output file (`name`: exact or with `*` wildcards; absent: any output). */
  z.strictObject({
    kind: z.literal('job_output'),
    jobId: Uuid,
    name: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[^/\\\0]+$/, 'a file name (with * wildcards), no path')
      .optional(),
  }),
  /**
   * A preview / Cloudflare tunnel link is up (open and its connector running): of a job, by tunnel id, or by its
   * project + name. `http: true` also checks the public URL from a worker before telling.
   */
  z
    .strictObject({
      kind: z.literal('preview_up'),
      jobId: Uuid.optional(),
      tunnelId: Uuid.optional(),
      project: Project.optional(),
      name: PreviewName.optional(),
      http: z.boolean().optional(),
    })
    .refine(
      (c) =>
        [
          c.jobId !== undefined,
          c.tunnelId !== undefined,
          c.project !== undefined && c.name !== undefined,
        ].filter(Boolean).length === 1,
      'name exactly one of jobId, tunnelId, or project + name',
    ),
  /** A URL answers as expected, checked from a worker (function job; the project's HTTP egress policy applies). */
  z.strictObject({
    kind: z.literal('http'),
    project: Project,
    url: z.url({ protocol: /^https?$/ }).max(2048),
    method: z.enum(['GET', 'HEAD']).optional(),
    expect: WatchHttpExpect.optional(),
    /** Check from this machine (default: any machine of the project that runs function jobs). */
    workerId: WorkerRef.optional(),
  }),
  /** A port on ONE machine's own localhost answers (`curl localhost:3000`): a probe job pinned to that machine. */
  z.strictObject({
    kind: z.literal('worker_probe'),
    project: Project,
    workerId: WorkerRef,
    probe: z.discriminatedUnion('type', [
      z.strictObject({
        type: z.literal('http'),
        port: PreviewPort,
        path: z
          .string()
          .max(512)
          .regex(/^\/(?!\/)[\x21-\x5b\x5d-\x7e]*$/, 'a path starting with /')
          .optional(),
        method: z.enum(['GET', 'HEAD']).optional(),
        expect: WatchHttpExpect.optional(),
      }),
      z.strictObject({ type: z.literal('tcp'), port: PreviewPort }),
    ]),
  }),
  /** A machine went online / offline, or a runtime on it is installed and signed in. */
  z
    .strictObject({
      kind: z.literal('machine'),
      workerId: WorkerRef,
      state: z.enum(['online', 'offline', 'runtime_ready']),
      runtime: z.enum(['claude-code', 'codex', 'pi', 'opencode']).optional(),
    })
    .refine((c) => (c.state === 'runtime_ready') === (c.runtime !== undefined), {
      message: 'runtime_ready needs the runtime (and only it)',
    }),
  /** A workflow run (or one of its steps, `nodeId`) reached one of the states (waiting = waits for a person). */
  z.strictObject({
    kind: z.literal('workflow_run'),
    runId: Uuid,
    states: z.array(z.enum(WATCH_RUN_STATES)).min(1).max(5),
    nodeId: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,47}$/)
      .optional(),
  }),
  /** A managed service's URL is up (p15-services; until that module is plugged in: unavailable). */
  z.strictObject({
    kind: z.literal('service_url'),
    serviceId: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
    http: z.boolean().optional(),
    /**
     * p21-service-exit: met when the service's process has ENDED (a one-shot command — seed, migration, a script
     * — exited by itself, gave up or its lifetime ended), with its state and exit code; not when it is up.
     */
    exited: z.boolean().optional(),
  }),
]);
export type WatchCheckCondition = z.infer<typeof WatchCheckCondition>;
export type WatchCheckKind = WatchCheckCondition['kind'];
export const WATCH_CHECK_KINDS: readonly WatchCheckKind[] = [
  'job_state',
  'job_event',
  'job_output',
  'preview_up',
  'http',
  'worker_probe',
  'machine',
  'workflow_run',
  'service_url',
];
/** Kinds checked by a worker on a schedule (everything else is evaluated when its rows change). */
export const POLLED_WATCH_KINDS: readonly WatchCheckKind[] = ['http', 'worker_probe'];

/**
 * p15-watch-autorun: how the `then` step goes when the condition is met. `auto` = the user asked for it to run: the
 * master runs it at once for the user who created the watch when the security policy lets the assistant act directly
 * (`autonomy.chatDirect`) and the step's event needs no authenticator code — otherwise it becomes a card. `ask` = the
 * user wants to confirm it first: always a card. Absent on rows stored before this field: `ask`.
 */
export const WATCH_THEN_MODES = ['auto', 'ask'] as const;
export const WatchThenMode = z.enum(WATCH_THEN_MODES);
export type WatchThenMode = z.infer<typeof WatchThenMode>;

/**
 * What happens when the condition is met besides the note: the master runs that step (mode `auto`, where the security
 * policy allows it) or prepares its card in the conversation — the same checks as the assistant's draft tools, for
 * the user who created the watch, re-checked when the condition is met.
 */
export const WatchThen = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('job_message'),
    jobId: Uuid,
    text: z.string().min(1).max(4000),
    mode: WatchThenMode.optional(),
  }),
  z.strictObject({
    action: z.literal('workflow_run'),
    workflowId: Uuid,
    inputs: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(4000)).optional(),
    mode: WatchThenMode.optional(),
  }),
  /**
   * p19-watch-deploy: deploy the project's configured Coolify target (the card of draft_deploy coolify.deploy, or
   * coolify.restart with `restart`); the project's deploy policy still decides (production may wait for an approval).
   */
  z.strictObject({
    action: z.literal('deploy'),
    project: Project,
    env: z.enum(['preview', 'production']).optional(),
    restart: z.boolean().optional(),
    force: z.boolean().optional(),
    mode: WatchThenMode.optional(),
  }),
]);
export type WatchThen = z.infer<typeof WatchThen>;

/** The last (or a dry) check of a watch as the console and the tools show it. */
export const WatchCheckView = z.object({
  at: z.string(),
  met: z.boolean(),
  /** One plain-text line in the watch's language. */
  summary: z.string().max(500),
  mode: z.enum(['dry', 'event', 'poll', 'reconcile']),
  /** The captured value (URL, status, JSONata value), already redacted and bounded. */
  value: z.unknown().optional(),
  /** The machine that ran a remote check. */
  workerId: z.string().max(128).nullable().optional(),
  error: z.string().max(80).nullable().optional(),
});
export type WatchCheckView = z.infer<typeof WatchCheckView>;
