import { apiRequest, obj } from './client';

/**
 * p16-ops-safety (docs/design/p16-ops-safety.md): Ayarlar → Operasyon güvenliği — keys and expiry
 * (`/ops-safety/expiry`), the model cost brake (`/cost-brake`), and the rollout circuit breaker (`/releases/breaker`,
 * `/releases/channels/:channel/{pause,resume,rollback}`). Never a secret: the master knows dates and states only.
 */

export type ExpiryState = 'ok' | 'soon' | 'urgent' | 'expired' | 'unknown' | 'error';
export type ExpiryBasis = 'expires' | 'rotation' | 'age';
export const EXPIRY_LABELS = [
  'apiToken',
  'cloudflareToken',
  'githubAppKey',
  'githubAppKeyFile',
  'coolifyToken',
  'tlsCertificate',
  'releaseKey',
  'totpKey',
  'leaseKey',
  'webhookHmac',
  'skillsPanelKey',
  'oidcSigningKey',
  'vapidKey',
  'backupIdentity',
  'vaultCredential',
  'gitHostToken',
  'gitHostPushToken',
] as const;
export type ExpiryLabel = (typeof EXPIRY_LABELS)[number];

export interface ExpiryItem {
  readonly id: string;
  readonly category: string;
  readonly label: ExpiryLabel;
  readonly name: string | null;
  readonly basis: ExpiryBasis;
  readonly dueAt: string | null;
  readonly daysLeft: number | null;
  readonly since: string | null;
  readonly ageDays: number | null;
  readonly rotateEveryDays: number | null;
  readonly rotatedAt: string | null;
  readonly state: ExpiryState;
  readonly detail: string | null;
  readonly checkedAt: string | null;
  readonly runbook: string;
  readonly stampable: boolean;
  readonly notifies: boolean;
}

export interface ExpirySummary {
  readonly total: number;
  readonly soon: number;
  readonly urgent: number;
  readonly expired: number;
  readonly unknown: number;
  readonly next: {
    readonly id: string;
    readonly label: ExpiryLabel;
    readonly name: string | null;
    readonly dueAt: string;
  } | null;
}

export interface ExpiryList {
  readonly items: readonly ExpiryItem[];
  readonly summary: ExpirySummary;
  readonly checkedAt: string | null;
}

const STATES: readonly ExpiryState[] = ['ok', 'soon', 'urgent', 'expired', 'unknown', 'error'];
const s = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const label = (v: unknown): ExpiryLabel =>
  (EXPIRY_LABELS as readonly string[]).includes(String(v)) ? (v as ExpiryLabel) : 'apiToken';

function parseItem(v: unknown): ExpiryItem {
  const o = obj(v);
  const basis = o.basis === 'expires' || o.basis === 'age' ? o.basis : 'rotation';
  return {
    id: s(o.id) ?? '',
    category: s(o.category) ?? '',
    label: label(o.label),
    name: s(o.name),
    basis,
    dueAt: s(o.dueAt),
    daysLeft: n(o.daysLeft),
    since: s(o.since),
    ageDays: n(o.ageDays),
    rotateEveryDays: n(o.rotateEveryDays),
    rotatedAt: s(o.rotatedAt),
    state: (STATES as readonly unknown[]).includes(o.state) ? (o.state as ExpiryState) : 'unknown',
    detail: s(o.detail),
    checkedAt: s(o.checkedAt),
    runbook: s(o.runbook) ?? '',
    stampable: o.stampable === true,
    notifies: o.notifies === true,
  };
}

export function parseExpirySummary(v: unknown): ExpirySummary {
  const o = obj(v);
  const next = o.next === null || o.next === undefined ? null : obj(o.next);
  return {
    total: n(o.total) ?? 0,
    soon: n(o.soon) ?? 0,
    urgent: n(o.urgent) ?? 0,
    expired: n(o.expired) ?? 0,
    unknown: n(o.unknown) ?? 0,
    next:
      next === null
        ? null
        : { id: s(next.id) ?? '', label: label(next.label), name: s(next.name), dueAt: s(next.dueAt) ?? '' },
  };
}

function parseExpiry(b: unknown): ExpiryList {
  const o = obj(b);
  return {
    items: Array.isArray(o.items) ? o.items.map(parseItem) : [],
    summary: parseExpirySummary(o.summary),
    checkedAt: s(o.checkedAt),
  };
}

export function getExpiry(): Promise<ExpiryList> {
  return apiRequest('GET', '/ops-safety/expiry', parseExpiry);
}

export function checkExpiryNow(): Promise<ExpiryList> {
  return apiRequest('POST', '/ops-safety/expiry/check', parseExpiry, { body: {} });
}

export function recordRotation(
  item: string,
  input: { rotatedAt?: string; note?: string } = {},
): Promise<void> {
  return apiRequest('POST', `/ops-safety/expiry/${encodeURIComponent(item)}/rotated`, () => undefined, {
    body: input,
  });
}

export function setVaultExpiry(id: string, expiresAt: string | null): Promise<void> {
  return apiRequest('PUT', `/ops-safety/vault/${encodeURIComponent(id)}/expiry`, () => undefined, {
    body: { expiresAt },
  });
}

// ------------------------------------------------------------------------------------------------ cost brake

export type CeilingLevel = 'ok' | 'warning' | 'exceeded';

export interface Ceiling {
  readonly scope: string;
  readonly window: 'day' | 'month';
  readonly windowEnd: string;
  readonly spentUsd: number;
  readonly limitUsd: number;
  readonly percent: number;
  readonly level: CeilingLevel;
  readonly lifted: boolean;
}

export interface CostLift {
  readonly id: string;
  readonly scope: string;
  readonly expiresAt: string;
  readonly reason: string;
  readonly createdBy: string | null;
}

export interface ProjectCeiling {
  readonly project: string;
  readonly dailyUsd: number | null;
  readonly monthlyUsd: number | null;
}

export interface CostBrake {
  readonly mode: 'warn' | 'block';
  readonly warnPercent: number;
  readonly ceilings: readonly Ceiling[];
  readonly engaged: readonly Ceiling[];
  readonly lifts: readonly CostLift[];
  readonly blocking: boolean;
  readonly projects: readonly ProjectCeiling[];
}

function parseCeiling(v: unknown): Ceiling {
  const o = obj(v);
  return {
    scope: s(o.scope) ?? 'global',
    window: o.window === 'month' ? 'month' : 'day',
    windowEnd: s(o.windowEnd) ?? '',
    spentUsd: n(o.spentUsd) ?? 0,
    limitUsd: n(o.limitUsd) ?? 0,
    percent: n(o.percent) ?? 0,
    level: o.level === 'warning' || o.level === 'exceeded' ? o.level : 'ok',
    lifted: o.lifted === true,
  };
}

export function parseCostBrake(b: unknown): CostBrake {
  const o = obj(b);
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  return {
    mode: o.mode === 'block' ? 'block' : 'warn',
    warnPercent: n(o.warnPercent) ?? 80,
    ceilings: arr(o.ceilings).map(parseCeiling),
    engaged: arr(o.engaged).map(parseCeiling),
    lifts: arr(o.lifts).map((x) => {
      const l = obj(x);
      return {
        id: s(l.id) ?? '',
        scope: s(l.scope) ?? 'global',
        expiresAt: s(l.expiresAt) ?? '',
        reason: s(l.reason) ?? '',
        createdBy: s(l.createdBy),
      };
    }),
    blocking: o.blocking === true,
    projects: arr(o.projects).map((x) => {
      const p = obj(x);
      return { project: s(p.project) ?? '', dailyUsd: n(p.dailyUsd), monthlyUsd: n(p.monthlyUsd) };
    }),
  };
}

export function getCostBrake(): Promise<CostBrake> {
  return apiRequest('GET', '/cost-brake', parseCostBrake);
}

export function liftCostBrake(input: { scope: string; hours: number; reason: string }): Promise<void> {
  return apiRequest('POST', '/cost-brake/lifts', () => undefined, { body: input });
}

export function endCostBrakeLift(id: string): Promise<void> {
  return apiRequest('DELETE', `/cost-brake/lifts/${encodeURIComponent(id)}`, () => undefined);
}

export function setProjectCeiling(
  project: string,
  input: { dailyUsd: number | null; monthlyUsd: number | null },
): Promise<void> {
  return apiRequest('PUT', `/cost-brake/projects/${encodeURIComponent(project)}`, () => undefined, {
    body: input,
  });
}

// ------------------------------------------------------------------------------------------------ breaker

export type MachineVerdict = 'ok' | 'pending' | 'update_failed' | 'crash_loop' | 'heartbeat_lost';

export interface BreakerHold {
  readonly id: string;
  readonly channel: string;
  readonly version: string;
  readonly rolloutPercent: number;
  readonly previousVersion: string | null;
  readonly reason: 'update_failures' | 'job_failures' | 'manual';
  readonly trippedAt: string;
  readonly failing: readonly {
    readonly workerId: string;
    readonly verdict: MachineVerdict;
    readonly reason: string | null;
  }[];
}

export interface BreakerChannel {
  readonly channel: string;
  readonly version: string;
  readonly rolloutPercent: number;
  readonly hold: BreakerHold | null;
  readonly judged: number;
  readonly failing: number;
  readonly pending: number;
  readonly failurePercent: number;
  readonly jobsBefore: number | null;
  readonly jobsAfter: number | null;
}

export interface BreakerStatus {
  readonly enabled: boolean;
  readonly failurePercent: number;
  readonly watchMinutes: number;
  readonly channels: readonly BreakerChannel[];
}

const VERDICTS: readonly MachineVerdict[] = [
  'ok',
  'pending',
  'update_failed',
  'crash_loop',
  'heartbeat_lost',
];

function parseHold(v: unknown): BreakerHold {
  const o = obj(v);
  const ev = typeof o.evidence === 'object' && o.evidence !== null ? obj(o.evidence) : {};
  const machines = Array.isArray(ev.machines) ? ev.machines : [];
  return {
    id: s(o.id) ?? '',
    channel: s(o.channel) ?? '',
    version: s(o.version) ?? '',
    rolloutPercent: n(o.rolloutPercent) ?? 0,
    previousVersion: s(o.previousVersion),
    reason: o.reason === 'job_failures' || o.reason === 'manual' ? o.reason : 'update_failures',
    trippedAt: s(o.trippedAt) ?? '',
    failing: machines.map((x) => {
      const m = obj(x);
      return {
        workerId: s(m.workerId) ?? '',
        verdict: (VERDICTS as readonly unknown[]).includes(m.verdict)
          ? (m.verdict as MachineVerdict)
          : 'update_failed',
        reason: s(m.reason),
      };
    }),
  };
}

export function parseBreaker(b: unknown): BreakerStatus {
  const o = obj(b);
  const st = typeof o.settings === 'object' && o.settings !== null ? obj(o.settings) : {};
  const channels = Array.isArray(o.channels) ? o.channels : [];
  return {
    enabled: st.breaker !== false,
    failurePercent: n(st.failurePercent) ?? 30,
    watchMinutes: n(st.watchMinutes) ?? 30,
    channels: channels.map((x) => {
      const c = obj(x);
      const v = typeof c.verdict === 'object' && c.verdict !== null ? obj(c.verdict) : {};
      const jobs =
        typeof v.jobFailurePercent === 'object' && v.jobFailurePercent !== null
          ? obj(v.jobFailurePercent)
          : {};
      return {
        channel: s(c.channel) ?? '',
        version: s(c.version) ?? '',
        rolloutPercent: n(c.rolloutPercent) ?? 0,
        hold: c.hold === null || c.hold === undefined ? null : parseHold(c.hold),
        judged: n(v.judged) ?? 0,
        failing: n(v.failing) ?? 0,
        pending: n(v.pending) ?? 0,
        failurePercent: n(v.failurePercent) ?? 0,
        jobsBefore: n(jobs.before),
        jobsAfter: n(jobs.after),
      };
    }),
  };
}

export function getBreaker(): Promise<BreakerStatus> {
  return apiRequest('GET', '/releases/breaker', parseBreaker);
}

export function breakerAction(channel: string, action: 'pause' | 'resume' | 'rollback'): Promise<void> {
  return apiRequest('POST', `/releases/channels/${encodeURIComponent(channel)}/${action}`, () => undefined, {
    body: {},
  });
}
