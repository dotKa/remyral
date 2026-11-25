import { apiRequest, int, obj, type RequestOptions } from './client';

/**
 * p15-autonomy (ADR-0056): Ayarlar → Güvenlik — the security policy (`GET/PUT /security/policy`,
 * `POST /security/policy/apply-autonomy`). The effective values are what the master enforces; `document` is the
 * stored preset plus overrides.
 */

export type SecurityPreset = 'serbest' | 'dengeli' | 'siki';
export const SECURITY_PRESETS: readonly SecurityPreset[] = ['serbest', 'dengeli', 'siki'];

export interface StepUpSettings {
  readonly windowMinutes: number | null;
  readonly rememberDevice: boolean | null;
  readonly alwaysFreshMinutes: number | null;
}

export interface AutonomySettings {
  readonly newProjectsHostExecution: boolean;
  readonly newProjectsAutoApprove: boolean;
  readonly jobApproval: 'allow-all' | 'ask-sensitive';
  readonly autoApprove: Readonly<Record<string, boolean>>;
  readonly chatDirect: boolean;
  /** p15-autonomy: the largest time limit a job may get (minutes). */
  readonly maxJobMinutes: number;
  /** p15-auto-mode: "Otomatik mod". */
  readonly autoMode: boolean;
  /** p15-auto-mode: automatic retries of transient failures (0 = off). */
  readonly autoRetryMax: number;
  /** p16-assistant-admin: destructive administration from the chat runs without a card (default off). */
  readonly chatDestructive: boolean;
  /** p19-chat-machine-admin: "Makinede söylediğimi yap" — machine work the user's own chat message asks for. */
  readonly chatMachineAdmin: boolean;
  /** p20-scope-preview: "Hedefe bağlı yetki" — continuations of the same goal inherit the user's turn, in scope. */
  readonly goalGrants: boolean;
  /** p22-timeout-continuity: "Süreyi kendiliğinden uzat" — a progressing job is extended at its time warning. */
  readonly autoExtendTime: boolean;
}

/** p16-api-tokens (ADR-0058): personal tokens allowed, longest lifetime, event grants (off by default). */
export interface ApiTokenSettings {
  readonly personal: boolean;
  readonly maxDays: number;
  readonly eventGrants: boolean;
}

/** p16-runtime-updates: fleet maintenance switches (unverified runtime updates: on by default in every preset). */
export interface FleetPolicySettings {
  readonly unverifiedRuntimeUpdates: boolean;
}

/** p16-zip-job-input (ADR-0060): native executables as job inputs from a .zip (off by default in every preset). */
export interface InputPolicySettings {
  readonly executables: boolean;
}

/** p16-ops-safety: request / chat rate limits per person and per API token (per minute / hour). */
export interface LimitPolicySettings {
  readonly userReadPerMinute: number;
  readonly userWritePerMinute: number;
  readonly tokenReadPerMinute: number;
  readonly tokenWritePerMinute: number;
  readonly chatPerMinute: number;
  readonly chatPerHour: number;
}

/** p16-ops-safety: the model cost brake (warn by default; block holds non-urgent jobs and assistant turns). */
export interface CostBrakePolicySettings {
  readonly mode: 'warn' | 'block';
  readonly dailyUsd: number | null;
  readonly monthlyUsd: number | null;
  readonly warnPercent: number;
}

/** p16-ops-safety: the worker rollout circuit breaker (on by default). */
export interface RolloutPolicySettings {
  readonly breaker: boolean;
  readonly failurePercent: number;
  readonly minFailures: number;
  readonly watchMinutes: number;
  readonly jobFailureDelta: number;
  readonly minJobs: number;
}

export const DEFAULT_LIMIT_SETTINGS: LimitPolicySettings = {
  userReadPerMinute: 600,
  userWritePerMinute: 120,
  tokenReadPerMinute: 600,
  tokenWritePerMinute: 120,
  chatPerMinute: 10,
  chatPerHour: 120,
};
export const DEFAULT_COST_BRAKE_SETTINGS: CostBrakePolicySettings = {
  mode: 'warn',
  dailyUsd: 50,
  monthlyUsd: 500,
  warnPercent: 80,
};
export const DEFAULT_ROLLOUT_SETTINGS: RolloutPolicySettings = {
  breaker: true,
  failurePercent: 30,
  minFailures: 1,
  watchMinutes: 30,
  jobFailureDelta: 30,
  minJobs: 5,
};

export interface EffectivePolicy {
  readonly preset: SecurityPreset;
  readonly customized: boolean;
  readonly stepUp: StepUpSettings;
  readonly events: Readonly<Record<string, boolean>>;
  readonly autonomy: AutonomySettings;
  readonly apiTokens: ApiTokenSettings;
  readonly fleet: FleetPolicySettings;
  readonly inputs: InputPolicySettings;
  readonly limits: LimitPolicySettings;
  readonly costBrake: CostBrakePolicySettings;
  readonly rollout: RolloutPolicySettings;
}

export interface CatalogEvent {
  readonly id: string;
  readonly category: string;
  readonly core: boolean;
  readonly presets: Readonly<Record<string, boolean>>;
}

export interface SecurityPolicyView {
  readonly version: number;
  readonly effective: EffectivePolicy;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly events: readonly CatalogEvent[];
  readonly changed?: readonly string[];
}

export interface SecurityPolicyPatch {
  readonly preset?: SecurityPreset;
  readonly resetOverrides?: boolean;
  readonly stepUp?: Partial<StepUpSettings>;
  readonly events?: Readonly<Record<string, boolean>>;
  readonly autonomy?: Partial<AutonomySettings>;
  readonly apiTokens?: Partial<ApiTokenSettings>;
  readonly fleet?: Partial<FleetPolicySettings>;
  readonly inputs?: Partial<InputPolicySettings>;
  readonly limits?: Partial<LimitPolicySettings>;
  readonly costBrake?: Partial<CostBrakePolicySettings>;
  readonly rollout?: Partial<RolloutPolicySettings>;
  readonly expectedVersion?: number;
}

function nullableNum(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}
function nullableBool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}
function bools(v: unknown): Record<string, boolean> {
  const o = obj(v);
  return Object.fromEntries(Object.entries(o).filter(([, x]) => typeof x === 'boolean')) as Record<
    string,
    boolean
  >;
}
function preset(v: unknown): SecurityPreset {
  return v === 'dengeli' || v === 'siki' ? v : 'serbest';
}

function sectionOf(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? obj(v) : {};
}
/** The numeric fields of a flat section, each falling back to its default. */
function numbers<T extends object>(v: unknown, defaults: T): T {
  const o = sectionOf(v);
  const out: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
  for (const [k, d] of Object.entries(defaults))
    if (typeof d === 'number' && typeof o[k] === 'number') out[k] = o[k];
  return out as T;
}
function costBrakeOf(v: unknown): CostBrakePolicySettings {
  const o = sectionOf(v);
  const usd = (x: unknown, d: number | null): number | null =>
    x === null ? null : typeof x === 'number' ? x : d;
  return {
    mode: o.mode === 'block' ? 'block' : 'warn',
    dailyUsd: usd(o.dailyUsd, DEFAULT_COST_BRAKE_SETTINGS.dailyUsd),
    monthlyUsd: usd(o.monthlyUsd, DEFAULT_COST_BRAKE_SETTINGS.monthlyUsd),
    warnPercent: typeof o.warnPercent === 'number' ? o.warnPercent : DEFAULT_COST_BRAKE_SETTINGS.warnPercent,
  };
}

export function parseSecurityPolicy(body: unknown): SecurityPolicyView {
  const b = obj(body);
  const e = obj(b.effective);
  const su = obj(e.stepUp);
  const au = obj(e.autonomy);
  // p16-api-tokens: absent from an older master's answer.
  const at = typeof e.apiTokens === 'object' && e.apiTokens !== null ? obj(e.apiTokens) : {};
  // p16-runtime-updates: absent from an older master's answer (which installs pinned versions only).
  const fl = typeof e.fleet === 'object' && e.fleet !== null ? obj(e.fleet) : null;
  const by = b.updatedBy === null || b.updatedBy === undefined ? null : obj(b.updatedBy);
  const catalog = obj(b.catalog);
  const events = Array.isArray(catalog.events) ? catalog.events : [];
  return {
    version: int(b, 'version'),
    effective: {
      preset: preset(e.preset),
      customized: e.customized === true,
      stepUp: {
        windowMinutes: nullableNum(su.windowMinutes),
        rememberDevice: nullableBool(su.rememberDevice),
        alwaysFreshMinutes: nullableNum(su.alwaysFreshMinutes),
      },
      events: bools(e.events),
      autonomy: {
        newProjectsHostExecution: au.newProjectsHostExecution === true,
        newProjectsAutoApprove: au.newProjectsAutoApprove === true,
        jobApproval: au.jobApproval === 'allow-all' ? 'allow-all' : 'ask-sensitive',
        autoApprove: bools(au.autoApprove),
        chatDirect: au.chatDirect === true,
        maxJobMinutes: typeof au.maxJobMinutes === 'number' ? au.maxJobMinutes : 12 * 60,
        autoMode: au.autoMode === true,
        autoRetryMax: typeof au.autoRetryMax === 'number' ? au.autoRetryMax : 0,
        chatDestructive: au.chatDestructive === true,
        // An older master has no switch: machine administration keeps its approvals there.
        chatMachineAdmin: au.chatMachineAdmin === true,
        // An older master has no switch: continuations behave as before (cards outside the user's own turn).
        goalGrants: au.goalGrants === true,
        // An older master has no switch: nothing is extended by itself there.
        autoExtendTime: au.autoExtendTime === true,
      },
      // An older master has no apiTokens: personal on, 365 days, no grants (what it would enforce: no tokens at all).
      apiTokens: {
        personal: at.personal !== false,
        maxDays: typeof at.maxDays === 'number' ? at.maxDays : 365,
        eventGrants: at.eventGrants === true,
      },
      fleet: { unverifiedRuntimeUpdates: fl === null ? false : fl.unverifiedRuntimeUpdates !== false },
      // p16-zip-job-input: absent from an older master's answer (it has no input bundles at all).
      inputs: { executables: sectionOf(e.inputs).executables === true },
      // p16-ops-safety: absent from an older master's answer (its fixed budgets, no brake, no breaker).
      limits: numbers(e.limits, DEFAULT_LIMIT_SETTINGS),
      costBrake: costBrakeOf(e.costBrake),
      rollout: {
        ...numbers(e.rollout, DEFAULT_ROLLOUT_SETTINGS),
        breaker: sectionOf(e.rollout).breaker !== false,
      },
    },
    updatedAt: typeof b.updatedAt === 'string' ? b.updatedAt : null,
    updatedBy: by === null ? null : typeof by.username === 'string' ? by.username : null,
    events: events.map((x) => {
      const o = obj(x);
      return {
        id: typeof o.id === 'string' ? o.id : '',
        category: typeof o.category === 'string' ? o.category : '',
        core: o.core === true,
        presets: bools(o.presets),
      };
    }),
    ...(Array.isArray(b.changed)
      ? { changed: b.changed.filter((c): c is string => typeof c === 'string') }
      : {}),
  };
}

export function getSecurityPolicy(opts: RequestOptions = {}): Promise<SecurityPolicyView> {
  return apiRequest('GET', '/security/policy', parseSecurityPolicy, opts);
}

export function putSecurityPolicy(patch: SecurityPolicyPatch): Promise<SecurityPolicyView> {
  return apiRequest('PUT', '/security/policy', parseSecurityPolicy, { body: patch });
}

export function applyAutonomyToProjects(): Promise<{ readonly count: number }> {
  return apiRequest('POST', '/security/policy/apply-autonomy', (b) => ({ count: int(obj(b), 'count') }), {
    body: {},
  });
}
