import { z } from 'zod';
import { APPROVAL_ACTIONS, type ApprovalAction } from '../approvals/policy.js';
import { STEP_UP_EVENT_IDS, STEP_UP_EVENTS, type StepUpEvent } from './events.js';

/**
 * p15-autonomy (ADR-0056, docs/design/p15-autonomy.md §2): the security policy document — one per master, edited in
 * Ayarlar → Güvenlik or through the assistant. Pure, DB-free.
 *
 * The stored document is a **preset plus overrides**: `{ preset, stepUp?, events?, autonomy? }`. The effective policy is
 * the preset's values with the overrides on top, so a value the document does not name (an event added by a later
 * release) takes the preset's default instead of a hard-coded one.
 *
 * Presets:
 * - `serbest` (the seed of migration 0118): one code holds for 12 h; only the safe core asks for a code; agents run with
 *   full autonomy (new projects allow host execution and auto-approve, jobs default to "never ask", master approvals of
 *   "never ask" jobs pass by policy), the assistant acts directly on explicit instructions (machine administration the
 *   user's own chat message asks for too, p19-chat-machine-admin).
 * - `dengeli` (a fresh install, migration 0221): 4 h window; the core plus credentials, logins, sandbox, machine admin, production deploys, integrations,
 *   releases and MCP installs ask for a code; master approvals still ask for deploys, force push, deletes outside the
 *   workspace and secret reads.
 * - `siki`: the behaviour before ADR-0056 — every event asks within the server's window (`AUTH_STEP_UP_MINUTES`,
 *   default 10 min), account-security routes always fresh (10 min), new projects confined, jobs "ask-sensitive", no
 *   master approval passes by policy, the assistant only drafts cards.
 */

export const SECURITY_PRESETS = ['serbest', 'dengeli', 'siki'] as const;
export type SecurityPreset = (typeof SECURITY_PRESETS)[number];

export const MIN_WINDOW_MINUTES = 5;
export const MAX_WINDOW_MINUTES = 30 * 24 * 60;
export const MAX_ALWAYS_FRESH_MINUTES = 60;
/** p15-auto-mode: the most automatic retries the policy may allow per job. */
export const MAX_AUTO_RETRIES = 5;

/**
 * Master approval actions the autonomy setting may let pass for "never ask" jobs. `machine.admin` is not among them:
 * elevated commands keep their own two switches (the machine's and the Machines project's, ADR-0021).
 */
export const AUTONOMY_ACTIONS = APPROVAL_ACTIONS.filter(
  (a): a is Exclude<ApprovalAction, 'machine.admin'> => a !== 'machine.admin',
);
export type AutonomyAction = (typeof AUTONOMY_ACTIONS)[number];

export const JOB_APPROVAL_DEFAULTS = ['allow-all', 'ask-sensitive'] as const;
export type JobApprovalDefault = (typeof JOB_APPROVAL_DEFAULTS)[number];

const EventId = z.enum(STEP_UP_EVENT_IDS as [StepUpEvent, ...StepUpEvent[]]);
const AutonomyActionId = z.enum(AUTONOMY_ACTIONS as [AutonomyAction, ...AutonomyAction[]]);

export const StepUpSettings = z.strictObject({
  /** How long one code holds for protected actions; null = the server's `AUTH_STEP_UP_MINUTES`. */
  windowMinutes: z.number().int().min(MIN_WINDOW_MINUTES).max(MAX_WINDOW_MINUTES).nullable(),
  /**
   * "Remember this device": on a remembered device (trusted device / "Remember me" session) one code holds for the
   * whole session; false = the window above; null = the server's `AUTH_STEP_UP_TRUSTED`.
   */
  rememberDevice: z.boolean().nullable(),
  /** Account-security routes (ALWAYS_FRESH_ROUTES) need a code from the last N minutes; null = the window above. */
  alwaysFreshMinutes: z.number().int().min(1).max(MAX_ALWAYS_FRESH_MINUTES).nullable(),
});
export type StepUpSettings = z.infer<typeof StepUpSettings>;

export const AutonomySettings = z.strictObject({
  /** New projects allow host-native profiles (where a machine has one ready). */
  newProjectsHostExecution: z.boolean(),
  /** New projects allow "never ask" jobs (approval policy allow-all, ADR-0020). */
  newProjectsAutoApprove: z.boolean(),
  /** The approval policy a job gets when its draft names none (allow-all only where the project allows it). */
  jobApproval: z.enum(JOB_APPROVAL_DEFAULTS),
  /** Per master approval action: true = passes by policy for "never ask" jobs, false = asks a human. */
  autoApprove: z.record(AutonomyActionId, z.boolean()),
  /** The assistant executes explicit instructions at once (no confirmation card) unless an event needs a code. */
  chatDirect: z.boolean(),
  /**
   * The largest time limit a job may get when its limit is set on a card or changed while it runs (minutes, up to the
   * protocol's 7 days).
   */
  maxJobMinutes: z
    .number()
    .int()
    .min(10)
    .max(7 * 24 * 60),
  /**
   * p15-auto-mode ("Otomatik mod"): every approval the policy can grant is granted without asking —
   * in-run tool approvals, merge decisions, deploys (production too), MCP tools — for trusted jobs that did not ask
   * for more prompts (ask-all / deny-sensitive). The hard floor keeps asking: machine administration, force push /
   * branch deletes / deletes outside the workspace, the safe-core step-up events. Also opens one auto-fix job after a
   * permanent failure. (p19-chat-machine-admin: machine administration the user's own chat message started passes by
   * `chatMachineAdmin` instead — independent of this switch.)
   */
  autoMode: z.boolean(),
  /** p15-auto-mode: automatic retries of a transient failure (0 = none; backoff 1, 5, 20, 60, 120 min). */
  autoRetryMax: z.number().int().min(0).max(MAX_AUTO_RETRIES),
  /**
   * p16-assistant-admin: the assistant may run DESTRUCTIVE administration (disable a user account, revoke a machine) at
   * once on the user's explicit instruction, like other chat commands. Off in every preset: such a change stays a card
   * the user confirms — also in "Otomatik mod". The event's authenticator-code rule applies either way.
   */
  chatDestructive: z.boolean(),
  /**
   * p19-chat-machine-admin ("Makinede söylediğimi yap": what the user asks for on a machine is what runs): when the
   * user's OWN chat message asks for machine work, (1) the elevated (root / Administrator) commands
   * of a machine administration job started from that message pass by policy instead of waiting for a human approval
   * (audited as approved by policy), and (2) starting such a job or a privileged sandbox prepare from the chat needs no
   * always-fresh code (the event's normal code rule still applies). Still needs the admin role, the machine's own
   * machine-admin switch and `chatDirect`. System-written turns (watch follow-ups, plan continuations) never get it.
   * On in Serbest and Dengeli, off in Sıkı.
   */
  chatMachineAdmin: z.boolean(),
  /**
   * p20-scope-preview ("Hedefe bağlı yetki"; without it the plan / watch continuation of the same goal falls back
   * to a card): what the user's OWN chat message ran directly is recorded for 6 hours as a scope (operation type,
   * machine, project); a continuation turn of that conversation (an approved autonomous plan, a watch follow-up)
   * inherits the user turn's direct run — and `chatMachineAdmin` for machine administration — only inside that scope.
   * Out of scope stays a card with one reason. Code rules, roles, the machine's own switch and always-card tools are
   * unchanged. Revoked per conversation or by turning this off. On in Serbest and Dengeli, off in Sıkı.
   */
  goalGrants: z.boolean(),
  /**
   * p22-timeout-continuity ("Süreyi kendiliğinden uzat"; a running job's time limit can be extended at any time): at
   * a job's time warning the platform extends it by itself — only while it progresses (it did
   * something in the last 10 minutes and waits for no person) and there is room under `maxJobMinutes` — by the
   * continuation step (the limit plus half, at least 30 minutes, within the maximum), at most AUTO_EXTEND_MAX_PER_JOB
   * (3) times per job; audited `job.time_limit.auto_extend` and said in the job's conversations. The assistant may also
   * extend a progressing job at once. On in Serbest and Dengeli, off in Sıkı.
   */
  autoExtendTime: z.boolean(),
});
export type AutonomySettings = z.infer<typeof AutonomySettings>;

/** p16-api-tokens (ADR-0058): the longest lifetime a token may get. */
export const MAX_TOKEN_DAYS = 365;

/**
 * p16-api-tokens (ADR-0058, docs/design/p16-api-tokens.md §3 and §6): API tokens and service accounts.
 */
export const ApiTokenSettings = z.strictObject({
  /** People may create personal tokens (Ayarlar → API anahtarları). Off: only service accounts get tokens. */
  personal: z.boolean(),
  /** The longest lifetime of a new or rotated token, in days (expiry is always required). */
  maxDays: z.number().int().min(1).max(MAX_TOKEN_DAYS),
  /**
   * Admins may grant a token step-up events at creation, with a fresh authenticator code (never the safe core). Off in
   * every preset: a token is refused for every event that asks for a code.
   */
  eventGrants: z.boolean(),
});
export type ApiTokenSettings = z.infer<typeof ApiTokenSettings>;

/**
 * p16-runtime-updates (docs/design/p16-runtime-updates.md §1): fleet maintenance switches.
 */
export const FleetSettings = z.strictObject({
  /**
   * A runtime version newer than the worker release's pin may be installed (marked "doğrulanmamış"; its capabilities
   * stay `unverified`, ADR-0008), jobs run on it and the automatic verification runs on a canary machine. On in every
   * preset by design; off = the pinned versions only, as before.
   */
  unverifiedRuntimeUpdates: z.boolean(),
});
export type FleetSettings = z.infer<typeof FleetSettings>;

/** p16-runtime-updates: the fleet settings in display order. */
export const FLEET_KEYS = ['unverifiedRuntimeUpdates'] as const;

/**
 * p16-zip-job-input (ADR-0060): what may reach an agent's workspace as a job input (a .zip from the chat or the job
 * composer). Every file type passes except native executables and libraries (ELF, PE, Mach-O by magic bytes; .exe,
 * .dll, .so, .dylib … by extension): `executables` lets them through. Off in every preset.
 */
export const InputSettings = z.strictObject({
  executables: z.boolean(),
});
export type InputSettings = z.infer<typeof InputSettings>;
export const INPUT_KEYS = ['executables'] as const;
export const DEFAULT_INPUTS: InputSettings = { executables: false };

/**
 * p16-ops-safety (docs/design/p16-ops-safety.md §3): request and chat rate limits per person and per API token, beyond
 * the login attempt limits. Requests per minute of one signed-in person / one API token (reads and writes separately;
 * the other route classes keep their fixed budgets) and chat messages (new messages, edits, regenerations) per person.
 * The defaults are the budgets the master enforced before (p7-rate-limit, p16-api-tokens) plus 10 / 120 chat messages.
 */
export const LimitSettings = z.strictObject({
  userReadPerMinute: z.number().int().min(10).max(100_000),
  userWritePerMinute: z.number().int().min(5).max(100_000),
  tokenReadPerMinute: z.number().int().min(10).max(100_000),
  tokenWritePerMinute: z.number().int().min(5).max(100_000),
  chatPerMinute: z.number().int().min(1).max(1_000),
  chatPerHour: z.number().int().min(1).max(10_000),
});
export type LimitSettings = z.infer<typeof LimitSettings>;
export const LIMIT_KEYS = [
  'userReadPerMinute',
  'userWritePerMinute',
  'tokenReadPerMinute',
  'tokenWritePerMinute',
  'chatPerMinute',
  'chatPerHour',
] as const;

export const COST_BRAKE_MODES = ['warn', 'block'] as const;
export type CostBrakeMode = (typeof COST_BRAKE_MODES)[number];

/**
 * p16-ops-safety §4: the model cost brake — ceilings on the dollars spent on API-billed model usage (jobs + chat; a
 * subscription run has no per-run dollar cost, ADR-0014) per UTC day and month, for the whole installation (per-project
 * ceilings live in `cost_brake_projects`). `warn` (default, every preset): owners are told at `warnPercent` and at 100 %,
 * a banner shows it, nothing stops. `block`: at 100 % new non-urgent jobs wait and new assistant turns are refused until
 * the window resets, the ceiling is raised or an owner lifts the brake for some hours (audited).
 */
export const CostBrakeSettings = z.strictObject({
  mode: z.enum(COST_BRAKE_MODES),
  dailyUsd: z.number().min(0.01).max(1_000_000).nullable(),
  monthlyUsd: z.number().min(0.01).max(10_000_000).nullable(),
  warnPercent: z.number().int().min(10).max(99),
});
export type CostBrakeSettings = z.infer<typeof CostBrakeSettings>;
export const COST_BRAKE_KEYS = ['mode', 'dailyUsd', 'monthlyUsd', 'warnPercent'] as const;

/**
 * p16-ops-safety §2: the worker rollout circuit breaker. During a channel rollout, when the machines that took the
 * channel's version fail (update failed / rolled back / timed out, crash loop, heartbeat lost within `watchMinutes`
 * after the update) at `failurePercent` or more — and at least `minFailures` of them — or their job failure rate rose
 * by `jobFailureDelta` points over the previous version (at least `minJobs` jobs), the rollout is held: no further
 * machine is offered the version until an administrator resumes or rolls back. On in every preset.
 */
export const RolloutSettings = z.strictObject({
  breaker: z.boolean(),
  failurePercent: z.number().int().min(1).max(100),
  minFailures: z.number().int().min(1).max(100),
  watchMinutes: z
    .number()
    .int()
    .min(5)
    .max(24 * 60),
  jobFailureDelta: z.number().int().min(5).max(100),
  minJobs: z.number().int().min(1).max(1_000),
});
export type RolloutSettings = z.infer<typeof RolloutSettings>;
export const ROLLOUT_KEYS = [
  'breaker',
  'failurePercent',
  'minFailures',
  'watchMinutes',
  'jobFailureDelta',
  'minJobs',
] as const;

/** p16-ops-safety: the same defaults in every preset (non-blocking; the owner chooses `block`). */
export const DEFAULT_LIMITS: LimitSettings = {
  userReadPerMinute: 600,
  userWritePerMinute: 120,
  tokenReadPerMinute: 600,
  tokenWritePerMinute: 120,
  chatPerMinute: 10,
  chatPerHour: 120,
};
export const DEFAULT_COST_BRAKE: CostBrakeSettings = {
  mode: 'warn',
  dailyUsd: 50,
  monthlyUsd: 500,
  warnPercent: 80,
};
export const DEFAULT_ROLLOUT: RolloutSettings = {
  breaker: true,
  failurePercent: 30,
  minFailures: 1,
  watchMinutes: 30,
  jobFailureDelta: 30,
  minJobs: 5,
};

/** The stored document (preset + overrides). */
export const SecurityPolicyDocument = z.strictObject({
  preset: z.enum(SECURITY_PRESETS),
  stepUp: StepUpSettings.partial().optional(),
  events: z.partialRecord(EventId, z.boolean()).optional(),
  autonomy: AutonomySettings.partial()
    .extend({ autoApprove: z.partialRecord(AutonomyActionId, z.boolean()).optional() })
    .optional(),
  apiTokens: ApiTokenSettings.partial().optional(),
  fleet: FleetSettings.partial().optional(),
  inputs: InputSettings.partial().optional(),
  limits: LimitSettings.partial().optional(),
  costBrake: CostBrakeSettings.partial().optional(),
  rollout: RolloutSettings.partial().optional(),
});
export type SecurityPolicyDocument = z.infer<typeof SecurityPolicyDocument>;

export interface EffectiveSecurityPolicy {
  readonly preset: SecurityPreset;
  /** The document overrides something of its preset. */
  readonly customized: boolean;
  readonly stepUp: StepUpSettings;
  readonly events: Readonly<Record<StepUpEvent, boolean>>;
  readonly autonomy: Readonly<
    Omit<AutonomySettings, 'autoApprove'> & { autoApprove: Readonly<Record<AutonomyAction, boolean>> }
  >;
  readonly apiTokens: Readonly<ApiTokenSettings>;
  readonly fleet: Readonly<FleetSettings>;
  readonly inputs: Readonly<InputSettings>;
  readonly limits: Readonly<LimitSettings>;
  readonly costBrake: Readonly<CostBrakeSettings>;
  readonly rollout: Readonly<RolloutSettings>;
}

function allActions(value: (a: AutonomyAction) => boolean): Record<AutonomyAction, boolean> {
  return Object.fromEntries(AUTONOMY_ACTIONS.map((a) => [a, value(a)])) as Record<AutonomyAction, boolean>;
}

function allEvents(value: (e: StepUpEvent) => boolean): Record<StepUpEvent, boolean> {
  return Object.fromEntries(STEP_UP_EVENT_IDS.map((e) => [e, value(e)])) as Record<StepUpEvent, boolean>;
}

/** Actions "Dengeli" keeps asking a human for (risk-based rules). */
const BALANCED_ASK: ReadonlySet<AutonomyAction> = new Set<AutonomyAction>([
  'deploy',
  'git.force_push',
  'fs.delete_outside_workspace',
  'secret.read',
]);

export const PRESETS: Readonly<Record<SecurityPreset, Omit<EffectiveSecurityPolicy, 'customized'>>> = {
  serbest: {
    preset: 'serbest',
    stepUp: { windowMinutes: 12 * 60, rememberDevice: true, alwaysFreshMinutes: null },
    events: allEvents((e) => STEP_UP_EVENTS[e].core),
    autonomy: {
      newProjectsHostExecution: true,
      newProjectsAutoApprove: true,
      jobApproval: 'allow-all',
      autoApprove: allActions(() => true),
      chatDirect: true,
      maxJobMinutes: 7 * 24 * 60,
      autoMode: true,
      autoRetryMax: 3,
      chatDestructive: false,
      chatMachineAdmin: true,
      goalGrants: true,
      autoExtendTime: true,
    },
    apiTokens: { personal: true, maxDays: MAX_TOKEN_DAYS, eventGrants: false },
    fleet: { unverifiedRuntimeUpdates: true },
    inputs: DEFAULT_INPUTS,
    limits: DEFAULT_LIMITS,
    costBrake: DEFAULT_COST_BRAKE,
    rollout: DEFAULT_ROLLOUT,
  },
  dengeli: {
    preset: 'dengeli',
    stepUp: { windowMinutes: 4 * 60, rememberDevice: true, alwaysFreshMinutes: null },
    events: allEvents((e) => STEP_UP_EVENTS[e].balanced),
    autonomy: {
      newProjectsHostExecution: true,
      newProjectsAutoApprove: true,
      jobApproval: 'allow-all',
      autoApprove: allActions((a) => !BALANCED_ASK.has(a)),
      chatDirect: true,
      maxJobMinutes: 24 * 60,
      autoMode: false,
      autoRetryMax: 3,
      chatDestructive: false,
      chatMachineAdmin: true,
      goalGrants: true,
      autoExtendTime: true,
    },
    apiTokens: { personal: true, maxDays: MAX_TOKEN_DAYS, eventGrants: false },
    fleet: { unverifiedRuntimeUpdates: true },
    inputs: DEFAULT_INPUTS,
    limits: DEFAULT_LIMITS,
    costBrake: DEFAULT_COST_BRAKE,
    rollout: DEFAULT_ROLLOUT,
  },
  siki: {
    preset: 'siki',
    stepUp: { windowMinutes: null, rememberDevice: null, alwaysFreshMinutes: 10 },
    events: allEvents(() => true),
    autonomy: {
      newProjectsHostExecution: false,
      newProjectsAutoApprove: false,
      jobApproval: 'ask-sensitive',
      autoApprove: allActions(() => false),
      chatDirect: false,
      maxJobMinutes: 12 * 60,
      autoMode: false,
      autoRetryMax: 0,
      chatDestructive: false,
      chatMachineAdmin: false,
      goalGrants: false,
      autoExtendTime: false,
    },
    apiTokens: { personal: true, maxDays: 90, eventGrants: false },
    // By design on for every preset; the versions stay labelled unverified and roll back to the pin.
    fleet: { unverifiedRuntimeUpdates: true },
    inputs: DEFAULT_INPUTS,
    limits: DEFAULT_LIMITS,
    costBrake: DEFAULT_COST_BRAKE,
    rollout: DEFAULT_ROLLOUT,
  },
};

/**
 * The document the master assumes when the policy row is missing (it never is after migration 0118; an unreadable row
 * or a missing table falls back to Sıkı instead). Since migration 0221 a fresh install starts on Dengeli; an
 * installation with a stored row keeps it, so this value never switches a configured preset.
 */
export const DEFAULT_DOCUMENT: SecurityPolicyDocument = { preset: 'dengeli' };

/** The effective policy of a stored document (preset values, overrides on top). */
export function effectivePolicy(doc: SecurityPolicyDocument): EffectiveSecurityPolicy {
  const base = PRESETS[doc.preset];
  const stepUp: StepUpSettings = { ...base.stepUp, ...stripUndefined(doc.stepUp ?? {}) };
  const events = { ...base.events, ...stripUndefined(doc.events ?? {}) } as Record<StepUpEvent, boolean>;
  const a = doc.autonomy ?? {};
  const { autoApprove: autoOverrides, ...autoRest } = a;
  const autonomy = {
    ...base.autonomy,
    ...stripUndefined(autoRest),
    autoApprove: { ...base.autonomy.autoApprove, ...stripUndefined(autoOverrides ?? {}) } as Record<
      AutonomyAction,
      boolean
    >,
  };
  const apiTokens: ApiTokenSettings = { ...base.apiTokens, ...stripUndefined(doc.apiTokens ?? {}) };
  const fleet: FleetSettings = { ...base.fleet, ...stripUndefined(doc.fleet ?? {}) };
  const inputs: InputSettings = { ...base.inputs, ...stripUndefined(doc.inputs ?? {}) };
  const limits: LimitSettings = { ...base.limits, ...stripUndefined(doc.limits ?? {}) };
  const costBrake: CostBrakeSettings = { ...base.costBrake, ...stripUndefined(doc.costBrake ?? {}) };
  const rollout: RolloutSettings = { ...base.rollout, ...stripUndefined(doc.rollout ?? {}) };
  const customized =
    JSON.stringify(apiTokens) !== JSON.stringify(base.apiTokens) ||
    JSON.stringify(fleet) !== JSON.stringify(base.fleet) ||
    INPUT_KEYS.some((k) => inputs[k] !== base.inputs[k]) ||
    LIMIT_KEYS.some((k) => limits[k] !== base.limits[k]) ||
    COST_BRAKE_KEYS.some((k) => costBrake[k] !== base.costBrake[k]) ||
    ROLLOUT_KEYS.some((k) => rollout[k] !== base.rollout[k]) ||
    JSON.stringify(stepUp) !== JSON.stringify(base.stepUp) ||
    STEP_UP_EVENT_IDS.some((e) => events[e] !== base.events[e]) ||
    JSON.stringify({ ...autonomy, autoApprove: null }) !==
      JSON.stringify({ ...base.autonomy, autoApprove: null }) ||
    AUTONOMY_ACTIONS.some((x) => autonomy.autoApprove[x] !== base.autonomy.autoApprove[x]);
  return {
    preset: doc.preset,
    customized,
    stepUp,
    events,
    autonomy,
    apiTokens,
    fleet,
    inputs,
    limits,
    costBrake,
    rollout,
  };
}

function stripUndefined<T extends object>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

/** The overrides that turn `preset` into `target` (the smallest document that stores it). */
export function documentFor(target: Omit<EffectiveSecurityPolicy, 'customized'>): SecurityPolicyDocument {
  const base = PRESETS[target.preset];
  const stepUp: Partial<StepUpSettings> = {};
  for (const k of ['windowMinutes', 'rememberDevice', 'alwaysFreshMinutes'] as const) {
    if (target.stepUp[k] !== base.stepUp[k]) (stepUp as Record<string, unknown>)[k] = target.stepUp[k];
  }
  const events: Partial<Record<StepUpEvent, boolean>> = {};
  for (const e of STEP_UP_EVENT_IDS) if (target.events[e] !== base.events[e]) events[e] = target.events[e];
  const autonomy: Record<string, unknown> = {};
  for (const k of [
    'newProjectsHostExecution',
    'newProjectsAutoApprove',
    'jobApproval',
    'chatDirect',
    'maxJobMinutes',
    'autoMode',
    'autoRetryMax',
    'chatDestructive',
    'chatMachineAdmin',
    'goalGrants',
    'autoExtendTime',
  ] as const) {
    if (target.autonomy[k] !== base.autonomy[k]) autonomy[k] = target.autonomy[k];
  }
  const auto: Partial<Record<AutonomyAction, boolean>> = {};
  for (const x of AUTONOMY_ACTIONS)
    if (target.autonomy.autoApprove[x] !== base.autonomy.autoApprove[x])
      auto[x] = target.autonomy.autoApprove[x];
  if (Object.keys(auto).length > 0) autonomy.autoApprove = auto;
  const apiTokens: Partial<ApiTokenSettings> = {};
  for (const k of API_TOKEN_KEYS) {
    if (target.apiTokens[k] !== base.apiTokens[k])
      (apiTokens as Record<string, unknown>)[k] = target.apiTokens[k];
  }
  const fleet: Partial<FleetSettings> = {};
  for (const k of FLEET_KEYS) {
    if (target.fleet[k] !== base.fleet[k]) (fleet as Record<string, unknown>)[k] = target.fleet[k];
  }
  const inputs = diffSection(INPUT_KEYS, target.inputs, base.inputs);
  const limits = diffSection(LIMIT_KEYS, target.limits, base.limits);
  const costBrake = diffSection(COST_BRAKE_KEYS, target.costBrake, base.costBrake);
  const rollout = diffSection(ROLLOUT_KEYS, target.rollout, base.rollout);
  return {
    preset: target.preset,
    ...(Object.keys(stepUp).length === 0 ? {} : { stepUp }),
    ...(Object.keys(events).length === 0 ? {} : { events }),
    ...(Object.keys(autonomy).length === 0 ? {} : { autonomy: autonomy }),
    ...(Object.keys(apiTokens).length === 0 ? {} : { apiTokens }),
    ...(Object.keys(fleet).length === 0 ? {} : { fleet }),
    ...(Object.keys(inputs).length === 0 ? {} : { inputs }),
    ...(Object.keys(limits).length === 0 ? {} : { limits }),
    ...(Object.keys(costBrake).length === 0 ? {} : { costBrake }),
    ...(Object.keys(rollout).length === 0 ? {} : { rollout }),
  };
}

/** p16-ops-safety: the values of a flat section that differ from the preset's. */
function diffSection<K extends string, T extends Readonly<Record<K, unknown>>>(
  keys: readonly K[],
  target: T,
  base: T,
): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (target[k] !== base[k]) (out as Record<string, unknown>)[k] = target[k];
  return out;
}

/** p16-api-tokens: the API token settings in display order. */
export const API_TOKEN_KEYS = ['personal', 'maxDays', 'eventGrants'] as const;

/**
 * A change request (`PUT /security/policy`, the assistant's `change_settings`): a preset (resets every override unless
 * the same request names some) and/or individual values.
 */
export const SecurityPolicyPatch = z.strictObject({
  preset: z.enum(SECURITY_PRESETS).optional(),
  /** With `preset`: drop the current overrides first (default true when a preset is named). */
  resetOverrides: z.boolean().optional(),
  stepUp: StepUpSettings.partial().optional(),
  events: z.partialRecord(EventId, z.boolean()).optional(),
  autonomy: AutonomySettings.partial()
    .extend({ autoApprove: z.partialRecord(AutonomyActionId, z.boolean()).optional() })
    .optional(),
  apiTokens: ApiTokenSettings.partial().optional(),
  fleet: FleetSettings.partial().optional(),
  inputs: InputSettings.partial().optional(),
  limits: LimitSettings.partial().optional(),
  costBrake: CostBrakeSettings.partial().optional(),
  rollout: RolloutSettings.partial().optional(),
});
export type SecurityPolicyPatch = z.infer<typeof SecurityPolicyPatch>;

/** Applies a patch to the current document; returns the new (minimal) document. */
export function applyPatch(
  current: SecurityPolicyDocument,
  patch: SecurityPolicyPatch,
): SecurityPolicyDocument {
  const preset = patch.preset ?? current.preset;
  const reset = patch.preset !== undefined && patch.resetOverrides !== false;
  const start = effectivePolicy(reset ? { preset } : { ...current, preset });
  const p = patch.autonomy ?? {};
  const { autoApprove, ...rest } = p;
  return documentFor({
    preset,
    stepUp: { ...start.stepUp, ...stripUndefined(patch.stepUp ?? {}) },
    events: { ...start.events, ...stripUndefined(patch.events ?? {}) },
    autonomy: {
      ...start.autonomy,
      ...stripUndefined(rest),
      autoApprove: { ...start.autonomy.autoApprove, ...stripUndefined(autoApprove ?? {}) },
    },
    apiTokens: { ...start.apiTokens, ...stripUndefined(patch.apiTokens ?? {}) },
    fleet: { ...start.fleet, ...stripUndefined(patch.fleet ?? {}) },
    inputs: { ...start.inputs, ...stripUndefined(patch.inputs ?? {}) },
    limits: { ...start.limits, ...stripUndefined(patch.limits ?? {}) },
    costBrake: { ...start.costBrake, ...stripUndefined(patch.costBrake ?? {}) },
    rollout: { ...start.rollout, ...stripUndefined(patch.rollout ?? {}) },
  });
}

/** Paths whose values differ between two effective policies (for the audit entry and the chat answer). */
export function changedPaths(a: EffectiveSecurityPolicy, b: EffectiveSecurityPolicy): string[] {
  const out: string[] = [];
  if (a.preset !== b.preset) out.push('preset');
  for (const k of ['windowMinutes', 'rememberDevice', 'alwaysFreshMinutes'] as const)
    if (a.stepUp[k] !== b.stepUp[k]) out.push(`stepUp.${k}`);
  for (const e of STEP_UP_EVENT_IDS) if (a.events[e] !== b.events[e]) out.push(`events.${e}`);
  for (const k of [
    'newProjectsHostExecution',
    'newProjectsAutoApprove',
    'jobApproval',
    'chatDirect',
    'maxJobMinutes',
    'autoMode',
    'autoRetryMax',
    'chatDestructive',
    'chatMachineAdmin',
    'goalGrants',
    'autoExtendTime',
  ] as const)
    if (a.autonomy[k] !== b.autonomy[k]) out.push(`autonomy.${k}`);
  for (const x of AUTONOMY_ACTIONS)
    if (a.autonomy.autoApprove[x] !== b.autonomy.autoApprove[x]) out.push(`autonomy.autoApprove.${x}`);
  for (const k of API_TOKEN_KEYS) if (a.apiTokens[k] !== b.apiTokens[k]) out.push(`apiTokens.${k}`);
  for (const k of FLEET_KEYS) if (a.fleet[k] !== b.fleet[k]) out.push(`fleet.${k}`);
  for (const k of INPUT_KEYS) if (a.inputs[k] !== b.inputs[k]) out.push(`inputs.${k}`);
  for (const k of LIMIT_KEYS) if (a.limits[k] !== b.limits[k]) out.push(`limits.${k}`);
  for (const k of COST_BRAKE_KEYS) if (a.costBrake[k] !== b.costBrake[k]) out.push(`costBrake.${k}`);
  for (const k of ROLLOUT_KEYS) if (a.rollout[k] !== b.rollout[k]) out.push(`rollout.${k}`);
  return out;
}

/** The autonomy scalar settings (everything but `autoApprove`), in display order. */
export const AUTONOMY_SCALARS = [
  'newProjectsHostExecution',
  'newProjectsAutoApprove',
  'jobApproval',
  'chatDirect',
  'maxJobMinutes',
  'autoMode',
  'autoRetryMax',
  'chatDestructive',
  'chatMachineAdmin',
  'goalGrants',
  'autoExtendTime',
] as const;

/** The set of master approval actions that pass by policy for "never ask" jobs. */
export function autoApprovedActions(p: EffectiveSecurityPolicy): ReadonlySet<ApprovalAction> {
  return new Set(AUTONOMY_ACTIONS.filter((a) => p.autonomy.autoApprove[a]));
}
